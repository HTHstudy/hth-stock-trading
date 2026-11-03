import { z } from 'zod';
import { paperReviewReportSchema } from './paper-review.js';

export const paperValidationCheckNames = [
  'checkpoints',
  'comparable',
  'beforeIntegrity',
  'afterIntegrity',
  'intervalEvidence',
  'priorFillsPreserved',
  'priorEventsPreserved',
  'priorIntentsPreserved',
  'configurationStable',
  'stopped',
  'leaseReleased',
  'noOpenIntents',
  'noActiveReservations',
  'stoppedBaseline',
  'workerCycle',
  'intentPath',
  'diagnosticsRecorded',
  'fillPath',
  'externalChanges',
  'cashMatchesFills',
  'positionsMatchFills',
  'ownershipMatchesFills',
  'manualHoldingsPreserved',
  'costBasisReplay',
] as const;
const ticks = z.number().int().min(0).max(60).nullable();
export const paperValidationRunSchema = z
  .object({
    id: z.uuid(),
    market: z.enum(['KR', 'US']),
    startsAt: z.iso.datetime({ offset: true }).nullable(),
    deadline: z.iso.datetime({ offset: true }),
    state: z.enum(['terminal-recorded', 'awaiting-result']),
    resultState: z
      .enum([
        'completed',
        'completed-with-incomplete-review',
        'execution-ended-early',
        'review-issues-found',
        'stopped-before-run-or-failed',
      ])
      .nullable(),
    deadlineElapsed: z.boolean(),
    clock: z.enum(['unverified', 'not-in-future']),
    finishedAt: z.iso.datetime({ offset: true }).nullable(),
    code: z
      .enum([
        'CANCELLED',
        'BROKER_LEASE_BUSY',
        'BROKER_LEASE_LOST',
        'PAPER_TRADING_DAY_REVIEW_REQUIRED',
        'PAPER_WORKER_DATA_NOT_READY',
        'PAPER_OBSERVATION_STALE',
        'PAPER_CONTROL_CHANGED',
        'PAPER_BUILD_CHANGED',
        'PAPER_VERSION_CONFLICT',
        'PAPER_DAY_REVIEW_NOT_REQUIRED',
        'PAPER_TRADING_DAY_REVIEW_NOT_REQUIRED',
        'PAPER_MARKET_STRATEGIES_INVALID',
        'PREREQUISITE_FAILED',
        'PREREQUISITE_UNVERIFIED',
        'START_MISSED',
        'PAPER_PREFLIGHT_FAILED',
        'PAPER_ACCOUNT_NOT_PRISTINE',
        'PAPER_CONFIGURATION_CHANGED',
        'PAPER_CLEANUP_INCOMPLETE',
        'PAPER_VALIDATION_NOT_COMPLETED',
      ])
      .nullable(),
    completedTicks: ticks,
    runningTicks: ticks,
    evidence: z.enum(['linked-review', 'after-checkpoint', 'before-checkpoint', 'request-only']),
    verdict: z.enum(['issues-found', 'incomplete', 'consistent-observed-state']).nullable(),
    checks: z.partialRecord(z.enum(paperValidationCheckNames), z.enum(['passed', 'failed', 'unverified'])).nullable(),
    observedCounts: paperReviewReportSchema.shape.evidence,
    stoppedAndCleaned: z.boolean().nullable(),
    executionEnabled: z.literal(false),
    canResume: z.literal(false),
    processLivenessChecked: z.literal(false),
    ledgerReviewRecomputed: z.literal(false),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.state === 'awaiting-result' &&
        (value.resultState !== null ||
          value.finishedAt !== null ||
          value.completedTicks !== null ||
          value.runningTicks !== null ||
          value.code !== null)) ||
      (value.state === 'terminal-recorded' && (value.resultState === null || value.finishedAt === null)) ||
      (value.runningTicks !== null && (value.completedTicks === null || value.runningTicks > value.completedTicks)) ||
      (value.evidence === 'linked-review' && (value.verdict === null || value.checks === null)) ||
      (value.evidence !== 'linked-review' &&
        (value.verdict !== null || value.checks !== null || value.observedCounts !== null))
    )
      context.addIssue({ code: 'custom', message: 'Invalid saved evidence relationship' });
    if (
      (value.resultState === 'completed' &&
        (value.completedTicks !== 60 ||
          value.runningTicks !== 60 ||
          value.verdict !== 'consistent-observed-state' ||
          value.stoppedAndCleaned !== true ||
          paperValidationCheckNames.some((name) => value.checks?.[name] !== 'passed'))) ||
      (value.resultState === 'completed-with-incomplete-review' && value.verdict !== 'incomplete') ||
      (value.resultState === 'review-issues-found' && value.verdict !== 'issues-found') ||
      (value.resultState !== null &&
        ['completed', 'completed-with-incomplete-review', 'execution-ended-early', 'review-issues-found'].includes(
          value.resultState,
        ) &&
        value.evidence !== 'linked-review')
    )
      context.addIssue({ code: 'custom', message: 'Invalid terminal evidence claim' });
  });
export const paperValidationStatusSchema = z
  .object({
    service: z.literal('paper-validation-status'),
    asOf: z.iso.datetime({ offset: true }),
    availability: z.enum(['available', 'not-recorded', 'unavailable']),
    runs: z.array(paperValidationRunSchema).max(50),
    rejectedCount: z.number().int().min(0).max(100),
    limited: z.boolean(),
    executionEnabled: z.literal(false),
    canResume: z.literal(false),
  })
  .strict()
  .refine((value) => value.availability === 'available' || value.runs.length === 0)
  .refine((value) => new Set(value.runs.map((run) => run.id)).size === value.runs.length);
export type PaperValidationStatus = z.infer<typeof paperValidationStatusSchema>;
export type PaperValidationRun = z.infer<typeof paperValidationRunSchema>;
