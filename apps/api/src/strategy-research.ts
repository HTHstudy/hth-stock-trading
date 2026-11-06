import { constants } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { reportHashSchema, strategyResearchListSchema, strategyResearchSummarySchema } from '@hth/contracts';
import type { StrategyResearchList, StrategyResearchSnapshot, StrategyResearchSummary } from '@hth/contracts';
import { contentHash } from '@hth/database';
import { parseStrategyResearchSnapshot } from '@hth/worker/strategy-research-snapshot';

const maxFileBytes = 1_048_576;
const maxTotalBytes = 16 * maxFileBytes;
const filename = /^[a-f0-9]{64}\.json$/;
const unavailable = () => new Error('STRATEGY_RESEARCH_UNAVAILABLE');

export function createStrategyResearchReader(directory: string) {
  async function root() {
    const handle = await open(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const identity = await handle.stat().catch(async () => {
      await handle.close();
      throw unavailable();
    });
    return {
      async verify() {
        const current = await lstat(directory);
        if (
          !current.isDirectory() ||
          current.isSymbolicLink() ||
          current.dev !== identity.dev ||
          current.ino !== identity.ino
        )
          throw unavailable();
      },
      close: () => handle.close(),
    };
  }

  async function read(name: string, budget: { remaining: number }): Promise<StrategyResearchSnapshot> {
    const handle = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > maxFileBytes) throw unavailable();
      // Reserve the EOF probe too, including failed parses, so a scan cannot exceed its I/O budget.
      if (before.size + 1 > budget.remaining) throw new Error('STRATEGY_RESEARCH_LIMIT');
      budget.remaining -= before.size + 1;
      const buffer = Buffer.alloc(before.size + 1);
      let bytes = 0;
      while (bytes < buffer.length) {
        const chunk = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
        if (chunk.bytesRead === 0) break;
        bytes += chunk.bytesRead;
      }
      const after = await handle.stat();
      const current = await lstat(join(directory, name));
      if (
        bytes !== before.size ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs ||
        !current.isFile() ||
        current.isSymbolicLink() ||
        current.dev !== before.dev ||
        current.ino !== before.ino
      )
        throw unavailable();
      const snapshot = parseStrategyResearchSnapshot(JSON.parse(buffer.subarray(0, bytes).toString('utf8')) as unknown);
      const { snapshotHash, ...payload } = snapshot;
      if (`${snapshotHash}.json` !== name || contentHash(payload) !== snapshotHash) throw unavailable();
      return snapshot;
    } finally {
      await handle.close();
    }
  }

  return {
    async list(): Promise<StrategyResearchList> {
      let directoryHandle;
      try {
        directoryHandle = await root();
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
          return strategyResearchListSchema.parse({ reports: [], rejectedCount: 0, limited: false });
        throw unavailable();
      }
      try {
        await directoryHandle.verify();
        const reports: StrategyResearchSummary[] = [];
        let rejectedCount = 0;
        let limited = false;
        let entriesRead = 0;
        const budget = { remaining: maxTotalBytes };
        const entries = await opendir(directory);
        for await (const entry of entries) {
          if (++entriesRead > 100) {
            limited = true;
            break;
          }
          if (!entry.name.endsWith('.json')) continue;
          if (!filename.test(entry.name) || !entry.isFile() || entry.isSymbolicLink()) {
            rejectedCount++;
            continue;
          }
          try {
            await directoryHandle.verify();
            const snapshot = await read(entry.name, budget);
            const first = snapshot.datasets[0]!;
            // A summary describes one instrument and interval; never mislabel a mixed snapshot.
            if (
              !snapshot.datasets.every(
                ({ request }) =>
                  request.instrument.market === first.request.instrument.market &&
                  request.instrument.symbol === first.request.instrument.symbol &&
                  request.interval === first.request.interval,
              )
            )
              throw unavailable();
            reports.push(
              strategyResearchSummarySchema.parse({
                snapshotHash: snapshot.snapshotHash,
                sourceResultHash: snapshot.sourceResultHash,
                instrument: first.request.instrument,
                interval: first.request.interval,
                currency: first.request.instrument.market === 'KR' ? 'KRW' : 'USD',
                periods: snapshot.datasets.length,
                rows: snapshot.rows.length,
              }),
            );
          } catch (error) {
            if (error instanceof Error && error.message === 'STRATEGY_RESEARCH_LIMIT') {
              limited = true;
              break;
            }
            rejectedCount++;
          }
        }
        await directoryHandle.verify();
        reports.sort((left, right) => left.snapshotHash.localeCompare(right.snapshotHash));
        return strategyResearchListSchema.parse({ reports, rejectedCount, limited });
      } catch {
        throw unavailable();
      } finally {
        await directoryHandle.close();
      }
    },
    async get(hash: string): Promise<StrategyResearchSnapshot> {
      if (!reportHashSchema.safeParse(hash).success) throw new Error('INVALID_RESEARCH_ID');
      let directoryHandle;
      try {
        directoryHandle = await root();
        await directoryHandle.verify();
        const snapshot = await read(`${hash}.json`, { remaining: maxFileBytes + 1 });
        await directoryHandle.verify();
        return snapshot;
      } catch {
        throw new Error('STRATEGY_RESEARCH_NOT_FOUND');
      } finally {
        await directoryHandle?.close();
      }
    },
  };
}

export type StrategyResearchReader = ReturnType<typeof createStrategyResearchReader>;
