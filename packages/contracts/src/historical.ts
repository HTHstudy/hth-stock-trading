import { z } from 'zod';
import { dataBlockerSchema } from './market-data.js';

const instant = z.iso.datetime({ offset: true });
const decimal = z
  .string()
  .regex(/^\d+(\.\d+)?$/)
  .max(30);
const instrument = z.object({ market: z.enum(['KR', 'US']), symbol: z.string().regex(/^[A-Z0-9.-]{1,40}$/) }).strict();
const daySchema = z
  .object({
    market: z.enum(['KR', 'US']),
    tradingDate: z.iso.date(),
    sessionsKnown: z.boolean(),
    sessions: z
      .array(
        z.object({ type: z.enum(['day', 'pre', 'regular', 'after']), startsAt: instant, endsAt: instant }).strict(),
      )
      .max(4)
      .readonly(),
  })
  .strict();

export const historicalCandleSchema = z
  .object({
    instrument,
    interval: z.enum(['1m', '1d']),
    timestamp: instant,
    tradingDate: z.iso.date(),
    open: decimal,
    high: decimal,
    low: decimal,
    close: decimal,
    volume: decimal,
    currency: z.enum(['KRW', 'USD']),
    adjusted: z.boolean(),
    source: z.string().min(1).max(40),
    isClosed: z.boolean(),
  })
  .strict();

export const historicalRequestSchema = z
  .object({
    instrument,
    interval: z.enum(['1m', '1d']),
    adjusted: z.boolean(),
    from: z.iso.date(),
    to: z.iso.date(),
    source: z.string().min(1).max(40),
  })
  .strict()
  .refine(
    (value) =>
      value.from <= value.to &&
      Date.parse(`${value.to}T00:00:00Z`) - Date.parse(`${value.from}T00:00:00Z`) <= 365 * 86_400_000,
  );

export const historicalObservationSchema = z
  .object({
    candle: historicalCandleSchema,
    observedAt: instant,
    page: z.number().int().min(1).max(100),
  })
  .strict();

export const historicalCalendarSchema = z.object({ day: daySchema, observedAt: instant }).strict();

export const historicalDatasetSchema = z
  .object({
    formatVersion: z.literal('historical-dataset-v1'),
    policyVersion: z.literal('market-data-v1'),
    request: historicalRequestSchema,
    startedAt: instant,
    completedAt: instant,
    pointInTime: z.literal(false),
    historicalNxtPolicy: z.literal('conservative-non-nxt'),
    instrument: z
      .object({ name: z.string(), currency: z.enum(['KRW', 'USD']), nxtSupportedAtCollection: z.boolean().nullable() })
      .strict(),
    calendars: z.array(historicalCalendarSchema).max(366),
    observations: z.array(historicalObservationSchema).max(20_000),
    assessments: z
      .array(
        z
          .object({
            timestamp: instant,
            status: z.enum(['closed', 'pending', 'blocked']),
            reason: dataBlockerSchema.nullable(),
            usableAt: instant.nullable(),
          })
          .strict(),
      )
      .max(20_000),
    candles: z.array(historicalCandleSchema).max(20_000),
    coverage: z
      .object({
        complete: z.boolean(),
        excludedBars: z.number().int().nonnegative(),
        pendingBars: z.number().int().nonnegative(),
        invalidBars: z.number().int().nonnegative(),
        days: z
          .array(
            z
              .object({
                date: z.iso.date(),
                expectedBars: z.number().int().nonnegative(),
                observedBars: z.number().int().nonnegative(),
                missingBars: z.number().int().nonnegative(),
                status: z.enum(['holiday', 'complete', 'missing', 'unsettled', 'unknown']),
              })
              .strict(),
          )
          .max(366),
      })
      .strict(),
    warnings: z.array(
      z.enum([
        'RETROSPECTIVE_DATA',
        'CURRENT_INSTRUMENT_METADATA',
        'US_GAPS_MAY_BE_NO_TRADES',
        'ADJUSTMENT_HISTORY_LIMITED',
      ]),
    ),
  })
  .strict()
  .refine((value) => {
    const start = Date.parse(value.startedAt);
    const end = Date.parse(value.completedAt);
    if (
      !(start <= end) ||
      ![...value.calendars, ...value.observations].every(
        (entry) => Date.parse(entry.observedAt) >= start && Date.parse(entry.observedAt) <= end,
      )
    )
      return false;
    const matchesRequest = (candle: z.infer<typeof historicalCandleSchema>) =>
      candle.instrument.market === value.request.instrument.market &&
      candle.instrument.symbol === value.request.instrument.symbol &&
      candle.interval === value.request.interval &&
      candle.adjusted === value.request.adjusted &&
      candle.source === value.request.source &&
      candle.currency === value.instrument.currency &&
      candle.tradingDate >= value.request.from &&
      candle.tradingDate <= value.request.to;
    if (![...value.candles, ...value.observations.map((entry) => entry.candle)].every(matchesRequest)) return false;
    if (new Set(value.candles.map((candle) => Date.parse(candle.timestamp))).size !== value.candles.length)
      return false;
    if (!value.coverage.complete) return true;
    const candleKey = (candle: z.infer<typeof historicalCandleSchema>) =>
      JSON.stringify([
        Date.parse(candle.timestamp),
        candle.tradingDate,
        candle.open,
        candle.high,
        candle.low,
        candle.close,
        candle.volume,
      ]);
    const observed = new Set(value.observations.map((entry) => candleKey(entry.candle)));
    const closed = new Set(
      value.assessments
        .filter((entry) => entry.status === 'closed' && entry.reason === null && entry.usableAt !== null)
        .map((entry) => Date.parse(entry.timestamp)),
    );
    const counts = new Map<string, number>();
    for (const candle of value.candles) counts.set(candle.tradingDate, (counts.get(candle.tradingDate) ?? 0) + 1);
    return (
      value.candles.length > 0 &&
      value.coverage.pendingBars === 0 &&
      value.coverage.invalidBars === 0 &&
      value.coverage.days.length === value.calendars.length &&
      value.coverage.days.length > 0 &&
      value.coverage.days.every(
        (day) =>
          (day.status === 'complete' || day.status === 'holiday') &&
          day.missingBars === 0 &&
          day.expectedBars === day.observedBars &&
          day.observedBars === (counts.get(day.date) ?? 0),
      ) &&
      value.candles.every(
        (candle) => candle.isClosed && closed.has(Date.parse(candle.timestamp)) && observed.has(candleKey(candle)),
      )
    );
  });

export type HistoricalRequest = z.infer<typeof historicalRequestSchema>;
export type HistoricalObservation = z.infer<typeof historicalObservationSchema>;
export type HistoricalCalendarObservation = z.infer<typeof historicalCalendarSchema>;
export type HistoricalDataset = z.infer<typeof historicalDatasetSchema>;
