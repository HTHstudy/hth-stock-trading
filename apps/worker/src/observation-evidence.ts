import { createHash } from 'node:crypto';
import { observationArtifactSchema, observationManifestSchema, observationRecordSchema } from '@hth/contracts';
import type { ObservationRecord } from '@hth/contracts';
import { contentHash } from '@hth/database';
const key = (item: { market: string; symbol: string }) => item.market + ':' + item.symbol;
export function aggregateObservationRecords(
  records: ObservationRecord[],
  status: 'completed' | 'cancelled' | 'failed',
) {
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

export function verifyObservationEvidence(manifestInput: unknown, terminalInput: unknown, journal: string) {
  const manifest = observationManifestSchema.parse(manifestInput),
    terminal = observationArtifactSchema.parse(terminalInput);
  if (
    Buffer.byteLength(journal) > 32 * 1048576 ||
    (journal && !journal.endsWith('\n')) ||
    contentHash(observationManifestSchema.strip().parse(terminal)) !== contentHash(manifest) ||
    createHash('sha256').update(journal).digest('hex') !== terminal.journalSha256
  )
    throw new Error('INVALID_OBSERVATION');
  const lines = journal ? journal.slice(0, -1).split('\n') : [];
  if (lines.length > manifest.samples) throw new Error('INVALID_OBSERVATION');
  const records = lines.map((line, index) => {
    const record = observationRecordSchema.parse(JSON.parse(line));
    const keys = new Set(record.instruments.map((item) => key(item.instrument)));
    if (
      record.index !== index + 1 ||
      (record.error
        ? record.instruments.length !== 0
        : keys.size !== manifest.instruments.length ||
          keys.size !== record.instruments.length ||
          manifest.instruments.some((item) => !keys.has(key(item))))
    )
      throw new Error('INVALID_OBSERVATION');
    return record;
  });
  if (
    contentHash(aggregateObservationRecords(records, terminal.summary.status)) !== contentHash(terminal.summary) ||
    (terminal.summary.status === 'completed' && records.length !== manifest.samples)
  )
    throw new Error('INVALID_OBSERVATION');
  return { manifest, summary: terminal.summary, records, journalSha256: terminal.journalSha256 };
}
