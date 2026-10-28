import { constants } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { backtestArtifactSchema, reportHashSchema } from '@hth/contracts';
import type { BacktestArtifact, BacktestList, BacktestSummary } from '@hth/contracts';
import { contentHash } from '@hth/database';

const maxFileBytes = 32 * 1_048_576;
export function createBacktestReports(directory: string) {
  async function read(name: string, limit = maxFileBytes): Promise<{ artifact: BacktestArtifact; bytes: number }> {
    const file = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > limit) throw new Error('INVALID_REPORT_FILE');
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of file.createReadStream({ autoClose: false, start: 0, end: limit })) {
        const buffer = chunk as Buffer;
        bytes += buffer.length;
        if (bytes > limit) throw new Error('INVALID_REPORT_FILE');
        chunks.push(buffer);
      }
      const parsed = backtestArtifactSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
      if (!parsed.success) throw new Error('INVALID_REPORT_FILE');
      const { reportHash, ...payload } = parsed.data;
      if (contentHash(payload) !== reportHash) throw new Error('INVALID_REPORT_HASH');
      return { artifact: parsed.data, bytes };
    } finally {
      await file.close();
    }
  }
  let cached: { until: number; list: BacktestList; names: Map<string, string> } | undefined;
  let loading: Promise<NonNullable<typeof cached>> | undefined;
  async function scan() {
    if (cached && cached.until > Date.now()) return cached;
    if (loading) return loading;
    loading = (async () => {
      const reports: BacktestSummary[] = [];
      const names = new Map<string, string>();
      let rejectedCount = 0;
      let limited = false;
      let bytes = 0;
      let candidates = 0;
      try {
        const info = await lstat(directory);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('REPORT_DIRECTORY_UNAVAILABLE');
        const entries = await opendir(directory);
        for await (const entry of entries) {
          if (++candidates > 100 || bytes >= 64 * 1_048_576) {
            limited = true;
            break;
          }
          if (!entry.name.endsWith('.json') || !entry.isFile() || entry.isSymbolicLink()) continue;
          try {
            const size = (await lstat(join(directory, entry.name))).size;
            if (size > maxFileBytes) {
              rejectedCount += 1;
              continue;
            }
            if (bytes + size > 64 * 1_048_576) {
              limited = true;
              break;
            }
            bytes += size;
            const result = await read(entry.name, size);
            const artifact = result.artifact;
            if (names.has(artifact.reportHash)) continue;
            names.set(artifact.reportHash, entry.name);
            const { strategy, config, currency, datasetRequest, metrics } = artifact.report;
            reports.push({
              reportHash: artifact.reportHash,
              dataset: artifact.dataset,
              strategy,
              config,
              currency,
              datasetRequest,
              metrics,
            });
          } catch {
            rejectedCount += 1;
          }
        }
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
          throw new Error('REPORT_DIRECTORY_UNAVAILABLE');
      }
      reports.sort((left, right) => left.reportHash.localeCompare(right.reportHash));
      cached = { until: Date.now() + 5000, list: { reports, rejectedCount, limited }, names };
      return cached;
    })();
    try {
      return await loading;
    } finally {
      loading = undefined;
    }
  }
  return {
    async list() {
      return (await scan()).list;
    },
    async get(hash: string) {
      if (!reportHashSchema.safeParse(hash).success) throw new Error('INVALID_REPORT_ID');
      const name = (await scan()).names.get(hash);
      if (!name) throw new Error('REPORT_NOT_FOUND');
      try {
        const { artifact } = await read(name);
        if (artifact.reportHash !== hash) throw new Error('REPORT_CHANGED');
        return artifact;
      } catch {
        cached = undefined;
        throw new Error('REPORT_NOT_FOUND');
      }
    },
  };
}
export type BacktestReports = ReturnType<typeof createBacktestReports>;
