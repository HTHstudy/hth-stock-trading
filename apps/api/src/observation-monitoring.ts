import { observationMonitoringSchema } from '@hth/contracts';
import type { ObservationRecord, ObservationReport } from '@hth/contracts';

// Passive evidence only. Fresh file updates do not prove process liveness or
// market readiness; silence does not distinguish sleep, storage and process loss.
export function observationMonitoring(
  manifest: ObservationReport['manifest'],
  records: readonly ObservationRecord[],
  terminal: boolean,
  now: number,
  partialWrite = false,
) {
  const graceMs = Math.max(30000, manifest.intervalMs);
  const gaps: {
    afterIndex: number;
    beforeIndex: number;
    from: string;
    to: string;
    waitMs: number;
    excessWaitMs: number;
  }[] = [];
  let maxWaitMs = 0,
    maxExcessWaitMs = 0;
  let clockUnverified = Date.parse(manifest.startedAt) > now + 1000;
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    if (Date.parse(record.finishedAt) < Date.parse(record.startedAt) || Date.parse(record.finishedAt) > now + 1000)
      clockUnverified = true;
    if (i === 0) continue;
    const previous = records[i - 1]!;
    const waitMs = Date.parse(record.startedAt) - Date.parse(previous.finishedAt);
    if (waitMs < 0) {
      clockUnverified = true;
      continue;
    }
    const excessWaitMs = Math.max(0, waitMs - manifest.intervalMs);
    maxWaitMs = Math.max(maxWaitMs, waitMs);
    maxExcessWaitMs = Math.max(maxExcessWaitMs, excessWaitMs);
    if (excessWaitMs > graceMs)
      gaps.push({
        afterIndex: previous.index,
        beforeIndex: record.index,
        from: previous.finishedAt,
        to: record.startedAt,
        waitMs,
        excessWaitMs,
      });
  }
  const last = records.at(-1);
  const deadline =
    Date.parse(last?.finishedAt ?? manifest.startedAt) +
    (last && records.length < manifest.samples ? manifest.intervalMs : 0) +
    manifest.timeoutMs +
    graceMs;
  return observationMonitoringSchema.parse({
    asOf: new Date(now).toISOString(),
    evidence: terminal ? 'final-hash-verified' : 'provisional',
    state: clockUnverified
      ? 'clock-unverified'
      : terminal
        ? 'terminal'
        : now > deadline
          ? 'overdue'
          : records.length === manifest.samples
            ? 'awaiting-finalization'
            : 'recent',
    lastRecordedAt: last?.finishedAt ?? null,
    lastSuccessfulAt: records.findLast((record) => record.error === null)?.finishedAt ?? null,
    deadlineAt: terminal || clockUnverified ? null : new Date(deadline).toISOString(),
    graceMs,
    gapCount: gaps.length,
    maxWaitMs,
    maxExcessWaitMs,
    recentGaps: gaps.slice(-10),
    partialWrite,
  });
}
