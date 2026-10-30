import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import {
  observationArtifactSchema,
  observationFailureSchema,
  observationListItemSchema,
  observationListSchema,
  observationManifestSchema,
  observationRecordSchema,
  observationReportSchema,
} from '@hth/contracts';
import type { ObservationReport, ObservationRecord, ObservationList } from '@hth/contracts';
import { contentHash } from '@hth/database';
import { createObservationJobs } from './observation-jobs.js';

const maxJournal = 32 * 1048576;
const key = (item: { market: string; symbol: string }) => `${item.market}:${item.symbol}`;
function aggregate(records: ObservationRecord[], status: 'completed' | 'cancelled' | 'failed') {
  const result = {
    samples: records.length,
    successfulSamples: 0,
    errorSamples: 0,
    healthy: 0,
    closed: 0,
    blocked: 0,
    quoteRegressions: 0,
    totalDurationMs: 0,
    maxDurationMs: 0,
    blockers: {} as Record<string, number>,
    errors: {} as Record<string, number>,
    instruments: {} as Record<
      string,
      {
        samples: number;
        healthy: number;
        closed: number;
        blocked: number;
        quoteRegressions: number;
        missingQuoteTimes: number;
        maxQuoteAgeMs: number | null;
      }
    >,
    status,
  };
  for (const record of records) {
    result.totalDurationMs += record.durationMs;
    result.maxDurationMs = Math.max(result.maxDurationMs, record.durationMs);
    if (record.error) {
      result.errorSamples++;
      result.errors[record.error] = (result.errors[record.error] ?? 0) + 1;
      continue;
    }
    result.successfulSamples++;
    for (const item of record.instruments) {
      result[item.state]++;
      if (item.quoteRegressed) result.quoteRegressions++;
      for (const code of new Set(item.blockers)) result.blockers[code] = (result.blockers[code] ?? 0) + 1;
      const counters = (result.instruments[key(item.instrument)] ??= {
        samples: 0,
        healthy: 0,
        closed: 0,
        blocked: 0,
        quoteRegressions: 0,
        missingQuoteTimes: 0,
        maxQuoteAgeMs: null,
      });
      counters.samples++;
      counters[item.state]++;
      if (item.quoteRegressed) counters.quoteRegressions++;
      if (item.quoteAgeMs === null) counters.missingQuoteTimes++;
      else counters.maxQuoteAgeMs = Math.max(counters.maxQuoteAgeMs ?? 0, item.quoteAgeMs);
    }
  }
  return result;
}
export function createObservationReports(directory: string, jobsDirectory?: string) {
  const root = resolve(directory);
  async function read(path: string, limit: number, charge?: (size: number) => void) {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > limit) throw new Error('INVALID_OBSERVATION');
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const part of file.createReadStream({ autoClose: false, start: 0, end: limit })) {
        const chunk = part as Buffer;
        size += chunk.length;
        charge?.(chunk.length);
        if (size > limit) throw new Error('INVALID_OBSERVATION');
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    } finally {
      await file.close();
    }
  }
  async function exists(path: string) {
    try {
      await lstat(path);
      return true;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
      throw error;
    }
  }
  async function verify(
    id: string,
    charge?: (size: number) => void,
  ): Promise<{ report: ObservationReport; bytes: number }> {
    if (!z.uuid().safeParse(id).success) throw new Error('INVALID_REPORT_ID');
    const folder = join(root, id);
    const rootInfo = await lstat(root),
      info = await lstat(folder);
    const canonicalRoot = await realpath(root);
    if (
      !rootInfo.isDirectory() ||
      rootInfo.isSymbolicLink() ||
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (await realpath(folder)) !== join(canonicalRoot, id)
    )
      throw new Error('INVALID_OBSERVATION');
    const manifestBytes = await read(join(folder, 'manifest.json'), 8192, charge);
    const manifest = observationManifestSchema.parse(JSON.parse(manifestBytes.toString('utf8')));
    if (manifest.id !== id) throw new Error('INVALID_OBSERVATION');
    const complete = await exists(join(folder, 'summary.json')),
      failed = await exists(join(folder, 'failure.json'));
    if (complete && failed) throw new Error('INVALID_OBSERVATION');
    const base = {
      manifest,
      state: 'incomplete' as const,
      finishedAt: null,
      journalSha256: null,
      summary: null,
      failureCode: null,
      recordedSamples: 0,
      recentSamples: [],
      samplesLimited: false,
    };
    if (!complete && !failed) return { report: observationReportSchema.parse(base), bytes: manifestBytes.length };
    const terminalBytes = await read(join(folder, complete ? 'summary.json' : 'failure.json'), 262144, charge);
    const terminal = complete
      ? observationArtifactSchema.parse(JSON.parse(terminalBytes.toString('utf8')))
      : observationFailureSchema.parse(JSON.parse(terminalBytes.toString('utf8')));
    const { finishedAt, journalSha256, summary } = terminal;
    const payload = observationManifestSchema.strip().parse(terminal);
    if (contentHash(payload) !== contentHash(manifest)) throw new Error('INVALID_OBSERVATION');
    const journal = await read(join(folder, 'samples.jsonl'), maxJournal, charge);
    if (createHash('sha256').update(journal).digest('hex') !== journalSha256) throw new Error('INVALID_OBSERVATION');
    const raw = journal.toString('utf8');
    if (raw && !raw.endsWith('\n')) throw new Error('INVALID_OBSERVATION');
    const lines = raw ? raw.slice(0, -1).split('\n') : [];
    if (lines.length > manifest.samples) throw new Error('INVALID_OBSERVATION');
    const records = lines.map((line, index) => {
      const record = observationRecordSchema.parse(JSON.parse(line));
      if (record.index !== index + 1) throw new Error('INVALID_OBSERVATION');
      const keys = new Set(record.instruments.map((item) => key(item.instrument)));
      if (
        record.error
          ? record.instruments.length !== 0
          : keys.size !== manifest.instruments.length ||
            keys.size !== record.instruments.length ||
            manifest.instruments.some((item) => !keys.has(key(item)))
      )
        throw new Error('INVALID_OBSERVATION');
      return record;
    });
    if (
      summary &&
      (contentHash(aggregate(records, summary.status)) !== contentHash(summary) ||
        (summary.status === 'completed' && records.length !== manifest.samples))
    )
      throw new Error('INVALID_OBSERVATION');
    if ((await realpath(folder)) !== join(canonicalRoot, id) || (await realpath(root)) !== canonicalRoot)
      throw new Error('INVALID_OBSERVATION');
    const failureCode = 'failure' in terminal ? terminal.failure.code : null;
    return {
      report: observationReportSchema.parse({
        ...base,
        state: summary?.status ?? 'failed',
        finishedAt,
        journalSha256,
        summary,
        failureCode,
        recordedSamples: records.length,
        recentSamples: records.slice(-50),
        samplesLimited: records.length > 50,
      }),
      bytes: manifestBytes.length + terminalBytes.length + journal.length,
    };
  }
  let cached: { until: number; list: ObservationList } | undefined;
  let loading: Promise<ObservationList> | undefined;
  return {
    async list(): Promise<ObservationList> {
      if (cached && cached.until > Date.now()) return cached.list;
      if (loading) return loading;
      loading = (async () => {
        const reports: ObservationList['reports'] = [];
        let rejectedCount = 0,
          limited = false,
          candidates = 0,
          bytes = 0;
        try {
          const rootInfo = await lstat(root);
          if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('OBSERVATIONS_UNAVAILABLE');
          for await (const entry of await opendir(root)) {
            if (++candidates > 100 || reports.length >= 50 || bytes >= 64 * 1048576) {
              limited = true;
              break;
            }
            if (!z.uuid().safeParse(entry.name).success) continue;
            try {
              if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('INVALID_OBSERVATION');
              const result = await verify(entry.name, (size) => {
                bytes += size;
                if (bytes > 64 * 1048576) {
                  limited = true;
                  throw new Error('OBSERVATION_SCAN_LIMIT');
                }
              });
              if (bytes > 64 * 1048576) {
                limited = true;
                break;
              }
              const { manifest, state, finishedAt, journalSha256, summary, failureCode, recordedSamples } =
                result.report;
              reports.push(
                observationListItemSchema.parse({
                  manifest,
                  state,
                  finishedAt,
                  journalSha256,
                  summary,
                  failureCode,
                  recordedSamples,
                }),
              );
            } catch {
              if (limited) break;
              rejectedCount++;
            }
          }
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
            throw new Error('OBSERVATIONS_UNAVAILABLE');
        }
        reports.sort(
          (a, b) =>
            Date.parse(b.manifest.startedAt) - Date.parse(a.manifest.startedAt) ||
            a.manifest.id.localeCompare(b.manifest.id),
        );
        const list = observationListSchema.parse({ reports, rejectedCount, limited });
        cached = { until: Date.now() + 5000, list };
        return list;
      })();
      try {
        return await loading;
      } finally {
        loading = undefined;
      }
    },
    async jobs() {
      if (!jobsDirectory) return { asOf: new Date().toISOString(), jobs: [], rejectedCount: 0, limited: false };
      return createObservationJobs(jobsDirectory).list();
    },
    async get(id: string) {
      if (!z.uuid().safeParse(id).success) throw new Error('INVALID_REPORT_ID');
      try {
        return (await verify(id)).report;
      } catch {
        cached = undefined;
        throw new Error('OBSERVATION_NOT_FOUND');
      }
    },
  };
}
export type ObservationReports = ReturnType<typeof createObservationReports>;
