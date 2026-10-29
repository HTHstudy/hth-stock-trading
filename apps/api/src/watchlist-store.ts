import { constants } from 'node:fs';
import { mkdir, lstat, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { watchlistInstrumentsSchema, watchlistStateSchema, watchlistUpdateSchema } from '@hth/contracts';
import type { WatchlistState } from '@hth/contracts';

const savedSchema = z
  .object({
    formatVersion: z.literal('watchlist-v1'),
    revision: z
      .number()
      .int()
      .min(1)
      .max(Number.MAX_SAFE_INTEGER - 1),
    instruments: watchlistInstrumentsSchema,
  })
  .strict();
export function environmentWatchlist(value: string | undefined) {
  const entries = (value ?? 'KR:005930,US:AAPL')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return watchlistInstrumentsSchema.parse(
    entries.map((item) => {
      const parts = item.split(':');
      if (parts.length !== 2) throw new Error('WATCHLIST_CONFIGURATION_INVALID');
      return { market: parts[0], symbol: parts[1] };
    }),
  );
}
export function createWatchlistStore(directory: string, fallback: unknown) {
  const initial = watchlistInstrumentsSchema.parse(fallback);
  const path = join(directory, 'watchlist.json');
  async function checkDirectory() {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('WATCHLIST_STORAGE_INVALID');
  }
  async function read(): Promise<WatchlistState> {
    try {
      await checkDirectory();
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size > 16384) throw new Error('WATCHLIST_STORAGE_INVALID');
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const part of file.createReadStream({ autoClose: false, start: 0, end: 16384 })) {
          const chunk = part as Buffer;
          bytes += chunk.length;
          if (bytes > 16384) throw new Error('WATCHLIST_STORAGE_INVALID');
          chunks.push(chunk);
        }
        const saved = savedSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        return watchlistStateSchema.parse({
          revision: saved.revision,
          origin: 'saved',
          instruments: saved.instruments,
        });
      } finally {
        await file.close();
      }
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        return watchlistStateSchema.parse({ revision: 0, origin: 'environment', instruments: initial });
      throw new Error('WATCHLIST_UNAVAILABLE');
    }
  }
  return {
    read,
    async save(value: unknown): Promise<WatchlistState> {
      const input = watchlistUpdateSchema.parse(value);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await checkDirectory();
      const lockPath = join(directory, 'watchlist.lock');
      let lock;
      try {
        lock = await open(lockPath, 'wx', 0o600);
      } catch {
        throw new Error('WATCHLIST_BUSY');
      }
      const temporary = join(directory, `.watchlist-${randomUUID()}.tmp`);
      try {
        const current = await read();
        if (current.revision !== input.expectedRevision) throw new Error('WATCHLIST_REVISION_CONFLICT');
        if (current.revision >= Number.MAX_SAFE_INTEGER - 1) throw new Error('WATCHLIST_REVISION_EXHAUSTED');
        const saved = savedSchema.parse({
          formatVersion: 'watchlist-v1',
          revision: current.revision + 1,
          instruments: input.instruments,
        });
        const file = await open(temporary, 'wx', 0o600);
        try {
          await file.writeFile(`${JSON.stringify(saved, null, 2)}\n`);
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporary, path);
        return watchlistStateSchema.parse({
          revision: saved.revision,
          origin: 'saved',
          instruments: saved.instruments,
        });
      } finally {
        await unlink(temporary).catch(() => {});
        await lock.close();
        await unlink(lockPath);
      }
    },
  };
}
export type WatchlistStore = ReturnType<typeof createWatchlistStore>;
