import { z } from 'zod';

export {
  dashboardSnapshotSchema,
  dashboardStateSchema,
  dashboardErrorSchema,
  dashboardWorkerMessageSchema,
} from './dashboard.js';
export type { DashboardSnapshot, DashboardState, DashboardErrorCode } from './dashboard.js';
export { dataBlockerSchema, marketDataQualitySchema } from './market-data.js';
export type { DataBlocker, MarketDataQuality } from './market-data.js';

export const marketSchema = z.enum(['KR', 'US']);
export const currencySchema = z.enum(['KRW', 'USD']);
export const decimalSchema = z.string().regex(/^-?\d+(\.\d+)?$/);
export const instantSchema = z.iso.datetime({ offset: true });
export const paperModeSchema = z.literal('paper').default('paper');

export type Market = z.infer<typeof marketSchema>;
export type Currency = z.infer<typeof currencySchema>;
export type DecimalString = z.infer<typeof decimalSchema>;

export interface InstrumentId {
  readonly market: Market;
  readonly symbol: string;
}

export interface Money {
  readonly amount: DecimalString;
  readonly currency: Currency;
}

export interface MarketSession {
  readonly type: 'day' | 'pre' | 'regular' | 'after';
  readonly startsAt: string;
  readonly endsAt: string;
}

export interface MarketDay {
  readonly market: Market;
  readonly tradingDate: string;
  readonly sessions: readonly MarketSession[];
  readonly sessionsKnown: boolean;
}

export interface MarketCalendar {
  readonly today: MarketDay;
  readonly previousBusinessDay: MarketDay;
  readonly nextBusinessDay: MarketDay;
}

export interface Candle {
  readonly instrument: InstrumentId;
  readonly interval: '1m' | '1d';
  readonly timestamp: string;
  readonly tradingDate: string;
  readonly open: DecimalString;
  readonly high: DecimalString;
  readonly low: DecimalString;
  readonly close: DecimalString;
  readonly volume: DecimalString;
  readonly currency: Currency;
  readonly adjusted: boolean;
  readonly source: string;
  readonly isClosed: boolean;
}

export const processHealthSchema = z.object({
  status: z.literal('ok'),
  service: z.literal('api'),
  mode: z.literal('paper'),
  executionEnabled: z.literal(false),
  scope: z.literal('process-only'),
});

export type ProcessHealth = z.infer<typeof processHealthSchema>;
