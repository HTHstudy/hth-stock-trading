import { z } from 'zod';

export const dataBlockerSchema = z.enum([
  'INVALID_DATA',
  'CALENDAR_MISSING',
  'CALENDAR_UNKNOWN',
  'CALENDAR_STALE',
  'MARKET_CLOSED',
  'OUTSIDE_REGULAR_SESSION',
  'METADATA_MISSING',
  'BAR_NOT_SETTLED',
  'BAR_NOT_REOBSERVED',
  'QUOTE_TIME_MISSING',
  'QUOTE_STALE',
  'ACCOUNT_STALE',
  'FX_EXPIRED',
  'FUTURE_DATA',
  'NO_CLOSED_CANDLES',
  'CANDLES_STALE',
  'INSTRUMENT_RESTRICTED',
  'ACCOUNT_UNAVAILABLE',
]);

export const marketDataQualitySchema = z.object({
  policyVersion: z.literal('market-data-v1'),
  checkedAt: z.iso.datetime({ offset: true }),
  readyCount: z.number().int().nonnegative(),
  instruments: z
    .array(
      z.object({
        key: z.string(),
        ready: z.boolean(),
        validUntil: z.iso.datetime({ offset: true }).nullable(),
        closedCandles: z.number().int().nonnegative(),
        pendingCandles: z.number().int().nonnegative(),
        blockedCandles: z.number().int().nonnegative(),
        strategyCandles: z.number().int().nonnegative(),
        blockers: z.array(dataBlockerSchema),
      }),
    )
    .max(20),
});

export type DataBlocker = z.infer<typeof dataBlockerSchema>;
export type MarketDataQuality = z.infer<typeof marketDataQualitySchema>;
