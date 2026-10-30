import { createHash } from 'node:crypto';
import { createConnection, createServer } from 'node:net';
import type { Socket } from 'node:net';
import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { dashboardWorkerMessageSchema, dashboardErrorSchema, watchlistInstrumentsSchema } from '@hth/contracts';
import type { DashboardSnapshot, InstrumentId } from '@hth/contracts';
import { BrokerError } from '@hth/broker';

export interface DashboardShareScope {
  clientId: string;
  clientSecret: string;
  databaseUrl: string;
  interval: '1m' | '1d';
}
const protocol = 'readonly-dashboard-v1' as const;
const requestSchema = z
  .object({ protocol: z.literal(protocol), operation: z.literal('snapshot'), instruments: watchlistInstrumentsSchema })
  .strict();
const responseSchema = z.object({ protocol: z.literal(protocol), message: dashboardWorkerMessageSchema }).strict();
const requestLimit = 4096;
const responseLimit = 8 * 1024 * 1024;
const absent = (error: unknown) =>
  error instanceof Error && 'code' in error && ['ENOENT', 'ECONNREFUSED'].includes(String(error.code));

export function dashboardShareAddress(scope: DashboardShareScope, directory?: string) {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('DASHBOARD_SHARE_UNAVAILABLE');
  const root = directory ?? `/tmp/hth-dashboard-${uid}`;
  const hash = createHash('sha256')
    .update(JSON.stringify([scope.clientId, scope.clientSecret, scope.databaseUrl, scope.interval]))
    .digest('hex')
    .slice(0, 32);
  const path = join(root, `${hash}.sock`);
  if (Buffer.byteLength(path) > 100) throw new Error('DASHBOARD_SHARE_UNAVAILABLE');
  return { root, path, uid };
}
async function privateDirectory(root: string, uid: number) {
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o777) !== 0o700)
    throw new Error('DASHBOARD_SHARE_UNAVAILABLE');
}

// Call only while holding the existing client/DB broker lease. Never replace
// an existing socket: a lost lease may still be draining its old owner.
export async function serveSharedDashboard(options: {
  scope: DashboardShareScope;
  signal: AbortSignal;
  load: (instruments: readonly InstrumentId[], signal: AbortSignal) => Promise<DashboardSnapshot>;
  directory?: string;
}) {
  const { root, path, uid } = dashboardShareAddress(options.scope, options.directory);
  options.signal.throwIfAborted();
  try {
    await mkdir(root, { mode: 0o700 });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST'))
      throw new Error('DASHBOARD_SHARE_UNAVAILABLE');
  }
  await privateDirectory(root, uid);
  try {
    await lstat(path);
    throw new Error('DASHBOARD_SHARE_UNAVAILABLE');
  } catch (error) {
    if (!absent(error)) throw new Error('DASHBOARD_SHARE_UNAVAILABLE');
  }
  const sockets = new Set<Socket>();
  let active: Promise<void> | null = null;
  let closing: Promise<void> | null = null;
  let inode: bigint | number | undefined;
  const server = createServer((socket) => {
    sockets.add(socket);
    const control = new AbortController();
    let buffer = Buffer.alloc(0),
      received = false;
    const timer = setTimeout(() => socket.destroy(), 5000);
    const stop = () => control.abort();
    socket.once('close', () => {
      clearTimeout(timer);
      stop();
      sockets.delete(socket);
    });
    socket.on('error', stop);
    const send = (message: unknown) => {
      if (socket.destroyed) return;
      const data = Buffer.from(JSON.stringify(responseSchema.parse({ protocol, message })) + '\n');
      if (data.length > responseLimit) {
        socket.destroy();
        return;
      }
      socket.setTimeout(5000, () => socket.destroy());
      socket.end(data);
    };
    socket.on('data', (chunk) => {
      if (received) {
        socket.destroy();
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > requestLimit) {
        socket.destroy();
        return;
      }
      const end = buffer.indexOf(10);
      if (end < 0) return;
      received = true;
      clearTimeout(timer);
      if (end !== buffer.length - 1) {
        socket.destroy();
        return;
      }
      let request: z.infer<typeof requestSchema>;
      try {
        request = requestSchema.parse(JSON.parse(buffer.subarray(0, end).toString('utf8')));
      } catch {
        send({ type: 'error', code: 'INVALID_INPUT' });
        return;
      }
      buffer = Buffer.alloc(0);
      if (closing || options.signal.aborted) {
        send({ type: 'error', code: 'CANCELLED' });
        return;
      }
      if (active) {
        send({ type: 'error', code: 'RATE_LIMITED' });
        return;
      }
      const deadline = setTimeout(() => {
        control.abort();
        socket.destroy();
      }, 110000);
      const signal = AbortSignal.any([options.signal, control.signal]);
      active = (async () => {
        await Promise.resolve();
        try {
          signal.throwIfAborted();
          const snapshot = await options.load(request.instruments, signal);
          signal.throwIfAborted();
          send({ type: 'snapshot', snapshot });
        } catch (error) {
          const code = dashboardErrorSchema.safeParse(
            error instanceof BrokerError ? error.code : error instanceof Error ? error.message : 'WORKER_ERROR',
          );
          send({ type: 'error', code: signal.aborted ? 'CANCELLED' : code.success ? code.data : 'WORKER_ERROR' });
        } finally {
          clearTimeout(deadline);
          active = null;
        }
      })();
    });
  });
  server.maxConnections = 8;
  const close = () => {
    closing ??= (async () => {
      options.signal.removeEventListener('abort', stop);
      const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
      for (const socket of sockets) socket.destroy();
      await active;
      await stopped;
      try {
        const info = await lstat(path);
        if (info.ino === inode) await unlink(path);
      } catch (error) {
        if (!absent(error)) throw new Error('DASHBOARD_SHARE_UNAVAILABLE');
      }
    })();
    return closing;
  };
  const stop = () => {
    void close().catch(() => {});
  };
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    await chmod(path, 0o600);
    inode = (await lstat(path)).ino;
    server.on('error', stop);
    options.signal.addEventListener('abort', stop, { once: true });
    if (options.signal.aborted) await close();
    options.signal.throwIfAborted();
    return { close };
  } catch {
    await close();
    throw new Error('DASHBOARD_SHARE_UNAVAILABLE');
  }
}

export async function requestSharedDashboard(
  scope: DashboardShareScope,
  instruments: readonly InstrumentId[],
  signal: AbortSignal,
  directory?: string,
): Promise<DashboardSnapshot | null> {
  if (signal.aborted) throw new BrokerError('CANCELLED');
  const request = requestSchema.parse({ protocol, operation: 'snapshot', instruments });
  const { root, path, uid } = dashboardShareAddress(scope, directory);
  try {
    await privateDirectory(root, uid);
    const info = await lstat(path);
    if (!info.isSocket() || info.uid !== uid || (info.mode & 0o077) !== 0)
      throw new Error('DASHBOARD_SHARE_UNAVAILABLE');
  } catch (error) {
    if (absent(error)) return null;
    throw new Error('DASHBOARD_SHARE_UNAVAILABLE');
  }
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let connected = false,
      done = false,
      buffer = Buffer.alloc(0);
    const finish = (result: DashboardSnapshot | null, error?: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(connectTimer);
      signal.removeEventListener('abort', cancel);
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    const cancel = () => finish(null, new BrokerError('CANCELLED'));
    const timer = setTimeout(() => finish(null, new Error('REFRESH_TIMEOUT')), 120000);
    const connectTimer = setTimeout(() => finish(null, new Error('DASHBOARD_SHARE_UNAVAILABLE')), 1000);
    signal.addEventListener('abort', cancel, { once: true });
    socket.once('connect', () => {
      connected = true;
      clearTimeout(connectTimer);
      if (signal.aborted) {
        cancel();
        return;
      }
      socket.write(JSON.stringify(request) + '\n');
    });
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > responseLimit) {
        finish(null, new BrokerError('INVALID_RESPONSE'));
        return;
      }
      const end = buffer.indexOf(10);
      if (end < 0) return;
      try {
        if (end !== buffer.length - 1) throw new Error('TRAILING_DATA');
        const response = responseSchema.parse(JSON.parse(buffer.subarray(0, end).toString('utf8')));
        if (response.message.type === 'error') finish(null, new Error(response.message.code));
        else finish(response.message.snapshot);
      } catch {
        finish(null, new BrokerError('INVALID_RESPONSE'));
      }
    });
    socket.once('end', () => {
      if (!done) finish(null, new BrokerError('INVALID_RESPONSE'));
    });
    socket.once('error', (error) => {
      if (!connected && absent(error)) finish(null);
      else finish(null, new Error('DASHBOARD_SHARE_UNAVAILABLE'));
    });
    if (signal.aborted) cancel();
  });
}
