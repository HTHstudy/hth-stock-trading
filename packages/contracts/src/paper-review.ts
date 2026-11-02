import { z } from 'zod';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const money = z
  .string()
  .regex(/^\d+(\.\d+)?$/)
  .max(80);
const signed = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/)
  .max(80);
const quantity = z.string().regex(/^\d+$/).max(30);
const holding = z
  .string()
  .regex(/^\d+(\.\d+)?$/)
  .max(30);
const instant = z.iso.datetime({ offset: true }).refine((value) => (value.match(/\.(\d+)/)?.[1]?.length ?? 0) <= 6);
const instrument = z.object({ market: z.enum(['KR', 'US']), symbol: z.string().regex(/^[A-Z0-9.-]{1,40}$/) }).strict();
const balance = z.object({ KRW: money, USD: money }).strict();
const pnl = z.object({ tradingDate: z.iso.date(), netPnl: signed }).strict();
const eventKind = z.enum([
  'ACCOUNT_CREATED',
  'SOURCE_REJECTED',
  'DAILY_REVIEW_COMPLETED',
  'LIMITS_CHANGED',
  'STRATEGY_CHANGED',
  'LEASE_ACQUIRED',
  'WORKER_RECOVERED',
  'LEASE_RELEASED',
  'ACCOUNT_OBSERVED',
  'ACCOUNT_RECONCILED',
  'PAPER_RESUMED',
  'PAPER_STOPPED',
  'INTENT_RECORDED',
  'INTENT_CONFLICT',
  'INTENT_ABORTED',
  'LEASE_REJECTED',
  'RISK_REJECTED',
  'RESERVATION_CREATED',
  'FILL_CONFLICT',
  'FILL_REJECTED',
  'LIMIT_NOT_REACHED',
  'PAPER_FILL_RECORDED',
  'STRATEGY_DIAGNOSED',
  'OTHER',
]);
export const paperReviewSnapshotSchema = z
  .object({
    formatVersion: z.literal('paper-review-snapshot-v1'),
    source: z.enum(['synthetic-only', 'toss-readonly']),
    scope: hash,
    asOf: instant,
    version: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER - 1),
    epoch: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER - 1),
    stopped: z.boolean(),
    leasePresent: z.boolean(),
    limitsHash: hash,
    strategyHash: hash,
    cash: balance,
    dailyPnl: z.object({ KRW: pnl, USD: pnl }).strict(),
    positions: z
      .array(
        z
          .object({
            instrument,
            quantity: holding,
            manualQuantity: holding,
            sellableQuantity: holding,
            ownership: z.array(z.object({ strategyKey: hash, quantity: holding }).strict()).max(1000),
          })
          .strict(),
      )
      .max(1000),
    basis: z.array(z.object({ instrument, strategyKey: hash, quantity: holding, amount: money }).strict()).max(5000),
    intents: z
      .array(
        z
          .object({
            key: hash,
            dedupeKey: hash,
            requestHash: hash,
            requestVerified: z.boolean(),
            dedupeVerified: z.boolean(),
            strategyKey: hash,
            instrument,
            side: z.enum(['BUY', 'SELL']),
            quantity,
            filledQuantity: quantity,
            filledNotional: money,
            paidCosts: money,
            state: z.enum(['INTENT_RECORDED', 'READY', 'PARTIALLY_FILLED', 'FILLED', 'RISK_REJECTED', 'ABORTED']),
          })
          .strict(),
      )
      .max(5000),
    fills: z
      .array(
        z
          .object({
            key: hash,
            intentKey: hash,
            requestHash: hash,
            requestVerified: z.boolean(),
            quantity,
            price: money,
            notional: money,
            costs: money,
            realizedPnl: signed,
            createdAt: instant,
          })
          .strict(),
      )
      .max(5000),
    reservations: z
      .array(
        z
          .object({ intentKey: hash, quantity, cashAmount: money, sellQuantity: quantity, active: z.boolean() })
          .strict(),
      )
      .max(5000),
    events: z.array(z.object({ key: hash, kind: eventKind, createdAt: instant }).strict()).max(5000),
  })
  .strict();
export const paperReviewCheckpointSchema = z
  .object({ formatVersion: z.literal('paper-review-checkpoint-v1'), snapshot: paperReviewSnapshotSchema, hash })
  .strict();
export type PaperReviewSnapshot = z.infer<typeof paperReviewSnapshotSchema>;
export type PaperReviewCheckpoint = z.infer<typeof paperReviewCheckpointSchema>;

const check = z.enum(['passed', 'failed', 'unverified']);
export const paperReviewReportSchema = z
  .object({
    formatVersion: z.literal('paper-review-report-v1'),
    asOf: instant,
    scope: hash.nullable(),
    source: z.enum(['synthetic-only', 'toss-readonly']).nullable(),
    beforeHash: hash.nullable(),
    afterHash: hash.nullable(),
    verdict: z.enum(['issues-found', 'incomplete', 'consistent-observed-state']),
    executionEnabled: z.literal(false),
    canResume: z.literal(false),
    checks: z.record(z.string().regex(/^[a-z][A-Za-z]+$/), check),
    evidence: z
      .object({
        newIntents: z.number().int().nonnegative(),
        newFills: z.number().int().nonnegative(),
        newObservations: z.number().int().nonnegative(),
        newDiagnostics: z.number().int().nonnegative(),
        leaseAcquisitions: z.number().int().nonnegative(),
        leaseReleases: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
    comparison: z
      .object({
        cashBefore: balance,
        cashAfter: balance,
        dailyPnlBefore: paperReviewSnapshotSchema.shape.dailyPnl,
        dailyPnlAfter: paperReviewSnapshotSchema.shape.dailyPnl,
        costs: balance,
        realizedPnl: z.object({ KRW: signed, USD: signed }).strict(),
        basisBefore: paperReviewSnapshotSchema.shape.basis,
        basisAfter: paperReviewSnapshotSchema.shape.basis,
      })
      .strict()
      .nullable(),
    limitations: z
      .array(
        z.enum([
          'CHECKPOINT_INTERVAL_ONLY',
          'NO_MARKET_DATA_REVALIDATION',
          'NO_EQUITY_OR_DAILY_PNL_REVALIDATION',
          'AMBIGUOUS_INTERVAL',
          'NO_PROFITABILITY_CLAIM',
          'NO_TRADING_AUTHORIZATION',
          'MISSING_CHECKPOINT',
          'INVALID_CHECKPOINT',
          'INCOMPARABLE_CHECKPOINTS',
          'NO_INTENT_OR_FILL',
          'AMBIGUOUS_FILL_ORDER',
          'UNSUPPORTED_LEDGER_CHANGE',
          'MULTIPLE_LEASE_CYCLES',
        ]),
      )
      .min(5),
  })
  .strict();
export type PaperReviewReport = z.infer<typeof paperReviewReportSchema>;
export const paperReviewArtifactSchema = z
  .object({ formatVersion: z.literal('paper-review-artifact-v1'), report: paperReviewReportSchema, hash })
  .strict();
