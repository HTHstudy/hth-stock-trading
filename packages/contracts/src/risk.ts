import { z } from 'zod';
import { historicalCalendarSchema, historicalCandleSchema } from './historical.js';

const instant = z.iso.datetime({ offset: true });
const id = z.string().regex(/^[A-Za-z0-9._:-]{1,100}$/);
const amount = z
  .string()
  .regex(/^\d+(\.\d+)?$/)
  .max(30);
const positive = amount.refine((value) => /[1-9]/.test(value));
const signed = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/)
  .max(30);
const bps = amount.refine((value) => Number(value) < 10_000);
const version = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER - 1);
const instrument = z.object({ market: z.enum(['KR', 'US']), symbol: z.string().regex(/^[A-Z0-9.-]{1,40}$/) }).strict();
const currencyLimits = z
  .object({
    maxOrderAmount: positive,
    maxInstrumentAmount: positive,
    maxDailyLoss: positive,
    buyCostBps: bps,
    sellCostBps: bps,
  })
  .strict();
export const paperRiskLimitsSchema = z
  .object({ KRW: currencyLimits, USD: currencyLimits, maxPositions: z.number().int().min(1).max(10_000) })
  .strict();
export const paperControlSchema = z
  .object({ mode: z.literal('paper'), stopped: z.boolean(), epoch: version, reason: z.string().min(1).max(200) })
  .strict();
export const paperOrderCandidateSchema = z
  .object({
    mode: z.literal('paper'),
    accountId: id,
    intentId: id,
    strategyId: id,
    instrument,
    side: z.enum(['BUY', 'SELL']),
    quantity: z.string().regex(/^[1-9]\d{0,11}$/),
    limitPrice: positive,
  })
  .strict();
const reservation = z
  .object({
    intentId: id,
    strategyId: id,
    instrument,
    side: z.enum(['BUY', 'SELL']),
    remainingQuantity: positive,
    limitPrice: positive,
    costBps: bps,
    filledNotional: amount.default('0'),
    paidCosts: amount.default('0'),
  })
  .strict();
const position = z
  .object({
    instrument,
    quantity: positive,
    manualQuantity: amount,
    sellableQuantity: amount,
    ownership: z.array(z.object({ strategyId: id, quantity: amount }).strict()).max(1000),
    markPrice: positive,
    markTimestamp: instant.nullable(),
    markObservedAt: instant,
  })
  .strict();
const daily = z.object({ tradingDate: z.iso.date(), netPnl: signed }).strict();
export const paperRiskSnapshotSchema = z
  .object({
    mode: z.literal('paper'),
    accountId: id,
    version,
    observedAt: instant,
    reconciled: z.boolean(),
    cash: z.object({ KRW: amount, USD: amount }).strict(),
    positions: z.array(position).max(10_000),
    reservations: z.array(reservation).max(10_000),
    dailyPnl: z.object({ KRW: daily, USD: daily }).strict(),
  })
  .strict();
const day = historicalCalendarSchema.shape.day;
export const paperRiskInputSchema = z
  .object({
    asOf: instant,
    candidate: paperOrderCandidateSchema,
    limits: paperRiskLimitsSchema.nullable(),
    control: paperControlSchema.nullable(),
    snapshot: paperRiskSnapshotSchema.nullable(),
    runtime: z
      .object({
        workerOwned: z.boolean(),
        sourcesHealthy: z.boolean(),
        hasUnknownOrders: z.boolean(),
        strategyEnabled: z.boolean(),
        dedupeClear: z.boolean(),
      })
      .strict(),
    quote: z.object({ instrument, price: positive, timestamp: instant.nullable(), observedAt: instant }).strict(),
    marketData: z
      .object({
        nxtSupported: z.boolean().nullable(),
        restricted: z.boolean(),
        candles: z.array(historicalCandleSchema).max(20_000),
        candlesObservedAt: instant,
        calendar: z.object({ today: day, previousBusinessDay: day, nextBusinessDay: day }).strict().nullable(),
        calendarObservedAt: instant.nullable(),
        exchangeRate: z.object({ validFrom: instant, validUntil: instant }).strict(),
      })
      .strict(),
  })
  .strict();
export const riskBlockerSchema = z.enum([
  'INVALID_INPUT',
  'INVALID_LIMITS',
  'LIMITS_NOT_CONFIGURED',
  'CONTROL_UNAVAILABLE',
  'EMERGENCY_STOP',
  'SNAPSHOT_UNAVAILABLE',
  'ACCOUNT_MISMATCH',
  'WORKER_NOT_OWNED',
  'SOURCE_UNHEALTHY',
  'UNKNOWN_ORDERS',
  'STRATEGY_DISABLED',
  'DUPLICATE_INTENT',
  'DATA_NOT_READY',
  'SIGNAL_NOT_CURRENT',
  'INVALID_LEDGER',
  'OWNERSHIP_MISMATCH',
  'RESERVATION_MISMATCH',
  'POSITION_MARK_STALE',
  'DAILY_PNL_DATE_MISMATCH',
  'DAILY_LOSS_LIMIT',
  'ORDER_AMOUNT_LIMIT',
  'INSTRUMENT_AMOUNT_LIMIT',
  'MAX_POSITIONS',
  'DUPLICATE_BUY',
  'OPEN_ORDER_CONFLICT',
  'INSUFFICIENT_CASH',
  'INSUFFICIENT_OWNED_QUANTITY',
]);
export type PaperRiskLimits = z.infer<typeof paperRiskLimitsSchema>;
export type PaperControl = z.infer<typeof paperControlSchema>;
export type PaperOrderCandidate = z.infer<typeof paperOrderCandidateSchema>;
export type PaperRiskSnapshot = z.infer<typeof paperRiskSnapshotSchema>;
export type PaperRiskInput = z.infer<typeof paperRiskInputSchema>;
export type RiskBlocker = z.infer<typeof riskBlockerSchema>;
