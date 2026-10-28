import { z } from 'zod';
import { paperIntentStateSchema } from './paper-ledger.js';
import { paperOrderCandidateSchema } from './risk.js';
import { paperStrategyViewSchema } from './paper-strategy.js';

const decimal = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/)
  .max(160);
const instant = z.iso.datetime({ offset: true });
const id = z.string().min(1).max(100);
export const paperReasonSchema = z.enum([
  'INITIAL_STOP',
  'LIMITS_CHANGED',
  'STRATEGY_CHANGED',
  'WORKER_RECOVERY_REQUIRED',
  'EXPLICIT_PAPER_RESUME',
  'WORKER_SHUTDOWN',
  'WORKER_FINISHED',
  'WORKER_FAILED',
  'WORKER_STEP_FAILED',
  'WORKER_START_FAILED',
  'DEMO_EMERGENCY_STOP',
  'DASHBOARD_EMERGENCY_STOP',
  'OTHER',
]);
export const paperEventKindSchema = z.enum([
  'ACCOUNT_CREATED',
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
  'OTHER',
]);
const instrument = paperOrderCandidateSchema.shape.instrument;
export const paperDashboardSnapshotSchema = z
  .object({
    asOf: instant,
    control: z
      .object({ stopped: z.boolean(), epoch: z.number().int().nonnegative(), reason: paperReasonSchema })
      .strict(),
    worker: z.object({ state: z.enum(['active', 'expired', 'absent']), leaseUntil: instant.nullable() }).strict(),
    valuation: z.object({ observedAt: instant, stale: z.boolean(), reconciled: z.boolean() }).strict(),
    portfolios: z
      .array(
        z
          .object({
            currency: z.enum(['KRW', 'USD']),
            cash: decimal,
            reservedCash: decimal,
            availableCash: decimal,
            holdingsValue: decimal,
            equity: decimal,
            dailyPnl: decimal,
            tradingDate: z.iso.date(),
          })
          .strict(),
      )
      .length(2),
    positions: z
      .array(
        z
          .object({
            instrument,
            quantity: decimal,
            manualQuantity: decimal,
            sellableQuantity: decimal,
            ownership: z.array(z.object({ strategyId: id, quantity: decimal }).strict()).max(1000),
            markPrice: decimal,
            value: decimal,
          })
          .strict(),
      )
      .max(10_000),
    strategies: z.array(paperStrategyViewSchema).max(10_000),
    orders: z
      .array(
        z
          .object({
            id,
            strategyId: id,
            instrument,
            side: z.enum(['BUY', 'SELL']),
            quantity: decimal,
            limitPrice: decimal,
            filledQuantity: decimal,
            filledNotional: decimal,
            paidCosts: decimal,
            state: paperIntentStateSchema,
            codes: z.array(z.string().max(100)).max(100),
            createdAt: instant,
          })
          .strict(),
      )
      .max(50),
    fills: z
      .array(
        z
          .object({
            id,
            orderId: id,
            instrument,
            side: z.enum(['BUY', 'SELL']),
            quantity: decimal,
            price: decimal,
            costs: decimal,
            realizedPnl: decimal,
            createdAt: instant,
          })
          .strict(),
      )
      .max(50),
    events: z
      .array(
        z
          .object({
            id,
            orderId: id.nullable(),
            kind: paperEventKindSchema,
            codes: z.array(z.string().max(100)).max(100),
            createdAt: instant,
          })
          .strict(),
      )
      .max(50),
    history: z
      .object({
        limit: z.literal(50),
        ordersLimited: z.boolean(),
        fillsLimited: z.boolean(),
        eventsLimited: z.boolean(),
      })
      .strict(),
  })
  .strict();
const context = { mode: z.literal('paper'), source: z.literal('synthetic-only'), executionEnabled: z.literal(false) };
export const paperDashboardStateSchema = z.discriminatedUnion('status', [
  z.object({ ...context, status: z.literal('disabled'), snapshot: z.null() }).strict(),
  z.object({ ...context, status: z.literal('ready'), snapshot: paperDashboardSnapshotSchema }).strict(),
]);
export const paperStopAcknowledgementSchema = z
  .object({ mode: z.literal('paper'), executionEnabled: z.literal(false), stopped: z.literal(true) })
  .strict();
export type PaperDashboardSnapshot = z.infer<typeof paperDashboardSnapshotSchema>;
export type PaperDashboardState = z.infer<typeof paperDashboardStateSchema>;
