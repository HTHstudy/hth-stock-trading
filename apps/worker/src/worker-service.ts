import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { workerRuntimeSchema } from '@hth/contracts';
import type { WorkerRuntime } from '@hth/contracts';
import { workerCommand } from './worker-service-config.js';
import type { WorkerServiceConfig } from './worker-service-config.js';

export async function runWorkerService(
  config: WorkerServiceConfig,
  signal: AbortSignal,
  directory = fileURLToPath(new URL('../../../.local-data/runtime', import.meta.url)),
) {
  signal.throwIfAborted();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const runtime: WorkerRuntime = {
    formatVersion: 'worker-runtime-v1',
    bootId: randomUUID(),
    mode: config.mode,
    source: config.source,
    state: 'starting',
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    lastProgressAt: null,
    intervalSeconds: config.mode === 'paper' ? 10 : config.intervalSeconds,
    code: null,
    executionEnabled: false,
  };
  const lifetime = new AbortController();
  const combined = AbortSignal.any([signal, lifetime.signal]);
  const waitForStop = () =>
    new Promise<void>((resolve) => {
      if (combined.aborted) resolve();
      else combined.addEventListener('abort', () => resolve(), { once: true });
    });
  let writes = Promise.resolve();
  let writeFailed = false;
  const save = () => {
    runtime.heartbeatAt = new Date().toISOString();
    const value = workerRuntimeSchema.parse({ ...runtime });
    writes = writes
      .then(async () => {
        const temporary = join(directory, `worker-${runtime.bootId}.tmp`);
        await writeFile(temporary, JSON.stringify(value) + '\n', { mode: 0o600 });
        await rename(temporary, join(directory, 'worker.json'));
      })
      .catch(() => {
        writeFailed = true;
        lifetime.abort();
      });
    return writes;
  };
  const update = (state: WorkerRuntime['state'], code: WorkerRuntime['code'] = null) => {
    runtime.state = state;
    runtime.code = code;
    console.info(
      JSON.stringify({
        service: 'worker-service',
        mode: config.mode,
        source: config.source,
        state,
        code,
        executionEnabled: false,
      }),
    );
    return save();
  };
  await save();
  const heartbeat = setInterval(() => {
    void save();
  }, 10000);
  try {
    const command = workerCommand(config);
    if (!command) await update('idle');
    else {
      let consumed = false;
      if (config.mode === 'observe') {
        try {
          await writeFile(
            join(directory, `observation-${config.requestId}.json`),
            JSON.stringify({
              formatVersion: 'worker-request-v1',
              requestId: config.requestId,
              bootId: runtime.bootId,
            }) + '\n',
            { flag: 'wx', mode: 0o600 },
          );
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'EEXIST') consumed = true;
          else throw error;
        }
      }
      if (consumed) await update('awaiting-request', 'REQUEST_ALREADY_CONSUMED');
      else {
        combined.throwIfAborted();
        await update(config.mode === 'observe' ? 'observing' : 'starting');
        const [entry, ...args] = command;
        const child = spawn(process.execPath, [fileURLToPath(new URL(`../dist/${entry!}`, import.meta.url)), ...args], {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, WORKER_REPORT_PROGRESS: '1' },
        });
        const stop = () => child.kill('SIGTERM');
        combined.addEventListener('abort', stop, { once: true });
        if (combined.aborted) stop();
        let buffer = '';
        let outcome: 'completed' | 'failed' | 'stopped' | undefined;
        let errorBuffer = '',
          controlledStop = false;
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk: string) => {
          errorBuffer += chunk;
          if (errorBuffer.length > 16384) {
            errorBuffer = '';
            return;
          }
          let end: number;
          while ((end = errorBuffer.indexOf('\n')) >= 0) {
            const line = errorBuffer.slice(0, end);
            errorBuffer = errorBuffer.slice(end + 1);
            try {
              const value: unknown = JSON.parse(line);
              if (value && typeof value === 'object' && 'code' in value && value.code === 'PAPER_CONTROL_CHANGED')
                controlledStop = true;
            } catch {
              /* Never forward raw stderr, errors or credentials. */
            }
          }
        });
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
          buffer += chunk;
          if (buffer.length > 16384) {
            buffer = '';
            return;
          }
          let end: number;
          while ((end = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, end);
            buffer = buffer.slice(end + 1);
            try {
              const value: unknown = JSON.parse(line);
              if (
                !value ||
                typeof value !== 'object' ||
                !('state' in value) ||
                !('executionEnabled' in value) ||
                value.executionEnabled !== false
              )
                continue;
              const state = value.state;
              if (state === 'completed' || state === 'failed' || state === 'stopped' || state === 'cancelled') {
                outcome = state === 'cancelled' ? 'stopped' : state;
              }
              if (state === 'running') {
                lifetime.abort();
                runtime.code = 'WORKER_OPERATION_FAILED';
                continue;
              }
              if (state === 'paused' || state === 'waiting' || state === 'observing') {
                runtime.state = state;
                runtime.lastProgressAt = new Date().toISOString();
                void save();
              }
            } catch {
              /* Child output is never returned verbatim or used as execution permission. */
            }
          }
        });
        try {
          const code = await new Promise<number | null>((resolve, reject) => {
            child.once('error', reject);
            child.once('close', resolve);
          });
          await update(
            writeFailed
              ? 'failed'
              : signal.aborted
                ? 'stopped'
                : controlledStop
                  ? 'stopped'
                  : code === 0
                    ? (outcome ?? 'stopped')
                    : 'failed',
            writeFailed ? 'WORKER_STATUS_FAILED' : code === 0 || controlledStop ? null : 'WORKER_OPERATION_FAILED',
          );
        } finally {
          combined.removeEventListener('abort', stop);
        }
      }
    }
    // A finite operation never becomes an automatic retry loop under Compose.
    if (!combined.aborted) await waitForStop();
  } catch {
    if (!signal.aborted) await update('failed', writeFailed ? 'WORKER_STATUS_FAILED' : 'WORKER_OPERATION_FAILED');
    if (!combined.aborted)
      try {
        await waitForStop();
      } catch {
        /* Shutdown. */
      }
  } finally {
    clearInterval(heartbeat);
    if (signal.aborted) await update('stopped');
    await writes;
  }
}
