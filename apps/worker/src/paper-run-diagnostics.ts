import { paperRunDiagnosticsArtifactSchema, paperRunDiagnosticsSummarySchema } from '@hth/contracts';
import type { PaperReviewCheckpoint, PaperRunDiagnosticsSummary } from '@hth/contracts';
import { contentHash } from '@hth/database';

const microtime = (time: string) =>
  BigInt(Date.parse(time)) * 1000n + BigInt((time.match(/\.(\d+)/)?.[1] ?? '').padEnd(6, '0').slice(3, 6));

export function summarizeRunDiagnostics(input: unknown, before: PaperReviewCheckpoint, after: PaperReviewCheckpoint) {
  const artifact = paperRunDiagnosticsArtifactSchema.parse(input);
  const { hash, ...body } = artifact;
  const a = before.snapshot,
    b = after.snapshot;
  if (
    contentHash(a) !== before.hash ||
    contentHash(b) !== after.hash ||
    contentHash(body) !== hash ||
    artifact.beforeHash !== before.hash ||
    artifact.afterHash !== after.hash ||
    artifact.scope !== a.scope ||
    a.scope !== b.scope ||
    a.source !== 'toss-readonly' ||
    b.source !== a.source ||
    a.version > b.version ||
    a.epoch > b.epoch ||
    new Set(a.events.map((event) => event.key)).size !== a.events.length ||
    new Set(b.events.map((event) => event.key)).size !== b.events.length ||
    microtime(a.asOf) > microtime(b.asOf) ||
    microtime(artifact.capturedAt) < microtime(b.asOf)
  )
    throw new Error('INVALID_DIAGNOSTICS');
  const prior = new Set(a.events.map((event) => event.key));
  const expected = b.events.filter((event) => event.kind === 'STRATEGY_DIAGNOSED' && !prior.has(event.key));
  const byKey = new Map(expected.map((event) => [event.key, event]));
  if (
    byKey.size !== expected.length ||
    new Set(artifact.events.map((event) => event.key)).size !== artifact.events.length ||
    artifact.events.length !== expected.length
  )
    throw new Error('INVALID_DIAGNOSTICS');
  const summary: PaperRunDiagnosticsSummary = {
    availability: 'available',
    recordedBatches: artifact.events.length,
    recordedReports: 0,
    actions: { BUY: 0, SELL: 0, HOLD: 0, unevaluated: 0 },
    stages: {},
    reasons: [],
  };
  const reasons = new Map<PaperRunDiagnosticsSummary['reasons'][number]['code'], number>();
  for (const event of artifact.events) {
    const reference = byKey.get(event.key),
      batch = event.batch;
    if (
      !reference ||
      contentHash(batch) !== event.batchHash ||
      batch.source !== a.source ||
      batch.accountVersion < a.version ||
      batch.accountVersion > b.version ||
      batch.epoch < a.epoch ||
      batch.epoch > b.epoch ||
      microtime(reference.createdAt) < microtime(a.asOf) ||
      microtime(reference.createdAt) > microtime(b.asOf) ||
      microtime(batch.recordedAt) < microtime(a.asOf) ||
      microtime(batch.recordedAt) > microtime(b.asOf)
    )
      throw new Error('INVALID_DIAGNOSTICS');
    for (const report of batch.reports) {
      if (
        microtime(report.evaluatedAt) < microtime(a.asOf) ||
        microtime(report.evaluatedAt) > microtime(b.asOf) ||
        microtime(report.evaluatedAt) > microtime(batch.recordedAt) + 5000000n
      )
        throw new Error('INVALID_DIAGNOSTICS');
      summary.recordedReports++;
      summary.actions[report.action ?? 'unevaluated']++;
      summary.stages[report.stage] = (summary.stages[report.stage] ?? 0) + 1;
      for (const code of new Set(report.codes)) reasons.set(code, (reasons.get(code) ?? 0) + 1);
    }
  }
  summary.reasons = [...reasons].sort(([a], [b]) => a.localeCompare(b)).map(([code, count]) => ({ code, count }));
  return paperRunDiagnosticsSummarySchema.parse(summary);
}

export function unavailableRunDiagnostics(): PaperRunDiagnosticsSummary {
  return {
    availability: 'unavailable',
    recordedBatches: 0,
    recordedReports: 0,
    actions: { BUY: 0, SELL: 0, HOLD: 0, unevaluated: 0 },
    stages: {},
    reasons: [],
  };
}
