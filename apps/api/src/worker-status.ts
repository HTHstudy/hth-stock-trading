import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { workerRuntimeSchema, workerStatusSchema } from '@hth/contracts';

export function createWorkerStatus(directory: string, now: () => number = Date.now) {
  const root = resolve(directory);
  return {
    async get() {
      const time = now(),
        asOf = new Date(time).toISOString();
      try {
        const directoryInfo = await lstat(root);
        if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error('INVALID_RUNTIME');
        const canonical = await realpath(root);
        const file = await open(
          join(root, 'worker.json'),
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        let raw: string;
        try {
          const info = await file.stat();
          if (!info.isFile() || info.size > 8192) throw new Error('INVALID_RUNTIME');
          const buffer = Buffer.alloc(8193);
          let length = 0;
          while (length < buffer.length) {
            const part = await file.read(buffer, length, buffer.length - length, length);
            if (!part.bytesRead) break;
            length += part.bytesRead;
          }
          if (length > 8192) throw new Error('INVALID_RUNTIME');
          raw = buffer.subarray(0, length).toString('utf8');
        } finally {
          await file.close();
        }
        if ((await realpath(root)) !== canonical) throw new Error('INVALID_RUNTIME');
        const runtime = workerRuntimeSchema.parse(JSON.parse(raw));
        const future = [runtime.startedAt, runtime.heartbeatAt, runtime.lastProgressAt].some(
          (value) => value && Date.parse(value) > time + 1000,
        );
        const reversed =
          Date.parse(runtime.heartbeatAt) < Date.parse(runtime.startedAt) ||
          (runtime.lastProgressAt !== null && Date.parse(runtime.lastProgressAt) < Date.parse(runtime.startedAt));
        const availability =
          future || reversed ? 'clock-unverified' : time - Date.parse(runtime.heartbeatAt) > 45000 ? 'stale' : 'fresh';
        const working = ['starting', 'observing', 'paused', 'waiting'].includes(runtime.state);
        const deadline =
          Date.parse(runtime.lastProgressAt ?? runtime.startedAt) +
          runtime.intervalSeconds * 1000 +
          10000 +
          Math.max(30000, runtime.intervalSeconds * 1000);
        const progress =
          availability !== 'fresh'
            ? 'unknown'
            : !working
              ? 'not-required'
              : time > deadline
                ? 'overdue'
                : runtime.lastProgressAt
                  ? 'recent'
                  : 'pending';
        return workerStatusSchema.parse({ asOf, availability, progress, runtime, executionEnabled: false });
      } catch {
        return workerStatusSchema.parse({
          asOf,
          availability: 'unavailable',
          progress: 'unknown',
          runtime: null,
          executionEnabled: false,
        });
      }
    },
  };
}
export type WorkerStatusReader = ReturnType<typeof createWorkerStatus>;
