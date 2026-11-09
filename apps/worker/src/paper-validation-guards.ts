import { z } from 'zod';
import {
  instantSchema,
  observationJobSchema,
  observationReportSchema,
  paperOrderCandidateSchema,
} from '@hth/contracts';
import type { PaperWorkerStatus } from './paper-worker.js';
import { contentHash } from '@hth/database';

// This age bounds reuse of a saved prerequisite, not quote freshness or a session oracle.
export const paperPrerequisiteMaxAgeMs = 15 * 60_000;
const rangeSchema = z.strictObject({ startedAt: instantSchema, finishedAt: instantSchema });
const contextSchema = z.strictObject({
  instrument: paperOrderCandidateSchema.shape.instrument,
  sessionStartsAt: instantSchema,
  sessionEndsAt: instantSchema,
  asOf: instantSchema,
});

// The caller must use the hash-verifying reader's entire-journal range, never its last 50 rows.
export function verifyPaperPrerequisite(jobInput: unknown, evidenceInput: unknown, contextInput: unknown) {
  try {
    const job = observationJobSchema.parse(jobInput);
    const { report, sampleRange } = z
      .strictObject({ report: observationReportSchema, sampleRange: rangeSchema })
      .parse(evidenceInput);
    const context = contextSchema.parse(contextInput);
    const sameInstrument = (item: { market: string; symbol: string }) =>
      item.market === context.instrument.market && item.symbol === context.instrument.symbol;
    const start = Date.parse(context.sessionStartsAt),
      end = Date.parse(context.sessionEndsAt);
    const now = Date.parse(context.asOf),
      finished = Date.parse(report.finishedAt ?? '');
    const sampleStart = Date.parse(sampleRange.startedAt),
      sampleEnd = Date.parse(sampleRange.finishedAt);
    if (
      job.state !== 'completed' ||
      job.reportId !== report.manifest.id ||
      !sameInstrument(job.instrument) ||
      job.requestedSamples !== 60 ||
      job.recordedSamples !== 60 ||
      report.state !== 'completed' ||
      report.manifest.source !== 'toss-readonly' ||
      report.manifest.instruments.length !== 1 ||
      !sameInstrument(report.manifest.instruments[0]!) ||
      report.manifest.samples !== 60 ||
      report.recordedSamples !== 60 ||
      report.manifest.intervalMs !== job.intervalSeconds * 1000 ||
      report.summary?.healthy !== 60 ||
      report.summary.successfulSamples !== 60 ||
      report.summary.errorSamples !== 0 ||
      report.summary.closed !== 0 ||
      report.summary.blocked !== 0 ||
      report.summary.quoteRegressions !== 0 ||
      report.monitoring?.evidence !== 'final-hash-verified' ||
      report.monitoring.state !== 'terminal' ||
      report.monitoring.gapCount !== 0 ||
      report.monitoring.partialWrite ||
      !report.journalSha256 ||
      end <= start ||
      now < start ||
      now >= end ||
      Date.parse(job.startsAt) < start ||
      Date.parse(job.startsAt) > sampleStart ||
      Date.parse(report.manifest.startedAt) < Date.parse(job.startsAt) ||
      Date.parse(report.manifest.startedAt) < start ||
      Date.parse(report.manifest.startedAt) > sampleStart ||
      sampleStart > sampleEnd ||
      sampleEnd >= end ||
      !Number.isFinite(finished) ||
      finished < sampleEnd ||
      finished >= end ||
      finished > now ||
      now - finished > paperPrerequisiteMaxAgeMs ||
      report.monitoring.lastRecordedAt !== sampleRange.finishedAt ||
      report.monitoring.lastSuccessfulAt !== sampleRange.finishedAt
    )
      throw new Error('PREREQUISITE_FAILED');
    return {
      formatVersion: 'paper-prerequisite-check-v1' as const,
      instrument: context.instrument,
      sessionStartsAt: context.sessionStartsAt,
      sessionEndsAt: context.sessionEndsAt,
      checkedAt: context.asOf,
      sampleRange,
      reportFinishedAt: report.finishedAt!,
      maximumAgeMs: paperPrerequisiteMaxAgeMs,
      evidenceHash: contentHash({
        job,
        manifest: report.manifest,
        finishedAt: report.finishedAt,
        journalSha256: report.journalSha256,
        summary: report.summary,
        sampleRange,
      }),
      // Calendar/session identity is independently rechecked on the fresh stopped observation.
      actualSessionVerified: false as const,
      executionEnabled: false as const,
    };
  } catch {
    throw new Error('PREREQUISITE_FAILED');
  }
}

export type PaperValidationStopCode = 'PAPER_VALIDATION_PAUSED' | 'PAPER_VALIDATION_WAITING';

// Throw from the tick callback so the existing run finally cleans up before this resolves.
// Only the exact error we created can be treated as an expected early stop. Cleanup errors win.
export async function runGuardedPaperValidationPhase(input: {
  resume: boolean;
  signal?: AbortSignal;
  run: (onTick: (status: PaperWorkerStatus) => void) => Promise<void>;
  onTick: (status: PaperWorkerStatus) => void;
}): Promise<PaperValidationStopCode | null> {
  const state: { stopped: { error: Error; code: PaperValidationStopCode } | null } = { stopped: null };
  input.signal?.throwIfAborted();
  try {
    await input.run((status) => {
      input.onTick(status);
      if (input.resume && status.state !== 'running') {
        const code = status.state === 'paused' ? 'PAPER_VALIDATION_PAUSED' : 'PAPER_VALIDATION_WAITING';
        state.stopped = { error: new Error(code), code };
        throw state.stopped.error;
      }
    });
  } catch (error) {
    if (state.stopped === null || error !== state.stopped.error) throw error;
    input.signal?.throwIfAborted();
    return state.stopped.code;
  }
  // A runtime that swallowed the callback exception still cannot turn the recorded stop into success.
  input.signal?.throwIfAborted();
  return state.stopped === null ? null : state.stopped.code;
}
