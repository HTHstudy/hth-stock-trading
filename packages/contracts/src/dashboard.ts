import { z } from 'zod';
import { marketDataQualitySchema } from './market-data.js';

const decimal = z.string().regex(/^-?\d+(\.\d+)?$/);
const instant = z.iso.datetime({ offset: true });
const market = z.enum(['KR', 'US']);
const currency = z.enum(['KRW', 'USD']);

export const dashboardSnapshotSchema = z.object({
  dataQuality: marketDataQualitySchema.optional(),
  collectedAt: instant,
  accountCount: z.number().int().nonnegative(),
  portfolios: z
    .array(z.object({ currency, value: decimal, cost: decimal, pnl: decimal, buyingPower: decimal }))
    .length(2),
  holdings: z
    .array(
      z.object({
        key: z.string(),
        symbol: z.string(),
        name: z.string(),
        market,
        currency,
        quantity: decimal,
        averagePurchasePrice: decimal,
        lastPrice: decimal,
        value: decimal,
        cost: decimal,
        pnl: decimal,
        pnlPercent: decimal.nullable(),
      }),
    )
    .max(1000),
  watchlist: z
    .array(
      z.object({
        key: z.string(),
        symbol: z.string(),
        name: z.string(),
        market,
        currency,
        price: decimal,
        timestamp: instant.nullable(),
        interval: z.enum(['1m', '1d']),
        candles: z
          .array(
            z.object({
              timestamp: instant,
              open: decimal,
              high: decimal,
              low: decimal,
              close: decimal,
              volume: decimal,
            }),
          )
          .max(200),
      }),
    )
    .max(20),
  markets: z
    .array(
      z.object({
        market,
        tradingDate: z.iso.date(),
        sessionsKnown: z.boolean(),
        sessions: z.array(
          z.object({ type: z.enum(['day', 'pre', 'regular', 'after']), startsAt: instant, endsAt: instant }),
        ),
      }),
    )
    .max(2),
  exchangeRate: z.object({ rate: decimal, midRate: decimal, validFrom: instant, validUntil: instant }),
});

export const dashboardErrorSchema = z.enum([
  'INVALID_INPUT',
  'INVALID_RESPONSE',
  'UNSUPPORTED_MARKET',
  'AUTHENTICATION_FAILED',
  'PERMISSION_DENIED',
  'RATE_LIMITED',
  'UPSTREAM_REJECTED',
  'UPSTREAM_UNAVAILABLE',
  'NETWORK_ERROR',
  'TIMEOUT',
  'CANCELLED',
  'READONLY_CONFIGURATION_INVALID',
  'BROKER_LEASE_BUSY',
  'BROKER_LEASE_LOST',
  'REFRESH_TIMEOUT',
  'WORKER_ERROR',
]);

export const dashboardStateSchema = z.object({
  mode: z.literal('paper'),
  executionEnabled: z.literal(false),
  connection: z.enum(['disabled', 'unconfigured', 'connecting', 'connected', 'error']),
  refreshing: z.boolean(),
  canRefresh: z.boolean(),
  error: dashboardErrorSchema.nullable(),
  snapshot: dashboardSnapshotSchema.nullable(),
});

export const dashboardWorkerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('snapshot'), snapshot: dashboardSnapshotSchema }),
  z.object({ type: z.literal('error'), code: dashboardErrorSchema }),
]);

export type DashboardSnapshot = z.infer<typeof dashboardSnapshotSchema>;
export type DashboardState = z.infer<typeof dashboardStateSchema>;
export type DashboardErrorCode = z.infer<typeof dashboardErrorSchema>;
