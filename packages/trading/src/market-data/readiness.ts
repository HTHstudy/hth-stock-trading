import type { Candle, InstrumentId, MarketCalendar } from '@hth/contracts';
import { instantSchema } from '@hth/contracts';
import { assessCandle } from './candles.js';
import { marketDataPolicy, marketDate, observationBlocker, validMarketDay } from './policy.js';
import type { DataBlocker } from './policy.js';

export interface StrategyDataInput {
  readonly instrument: InstrumentId;
  readonly nxtSupported: boolean | null;
  readonly restricted: boolean;
  readonly candles: readonly Candle[];
  readonly candlesObservedAt: string;
  readonly quoteTimestamp: string | null;
  readonly quoteObservedAt: string;
  readonly accountObservedAt: string;
  readonly accountAvailable: boolean;
  readonly calendar: MarketCalendar | null;
  readonly calendarObservedAt: string | null;
  readonly exchangeRate: { readonly validFrom: string; readonly validUntil: string };
  readonly asOf: string;
}

export type MarketDataInput = Omit<StrategyDataInput, 'accountObservedAt' | 'accountAvailable'>;
export function prepareStrategyData(input: StrategyDataInput) {
  return assess(input, { observedAt: input.accountObservedAt, available: input.accountAvailable });
}
export function assessMarketData(input: MarketDataInput) {
  return assess(input);
}
function assess(input: MarketDataInput, account?: { observedAt: string; available: boolean }) {
  const blockers = new Set<DataBlocker>();
  const now = Date.parse(input.asOf);
  if (!instantSchema.safeParse(input.asOf).success || !Number.isFinite(now))
    return {
      ready: false,
      blockers: ['INVALID_DATA'] as DataBlocker[],
      candles: [] as Candle[],
      assessments: [],
      validUntil: null,
    };
  const calendars = input.calendar
    ? [input.calendar.previousBusinessDay, input.calendar.today, input.calendar.nextBusinessDay]
    : [];
  const currentDay = calendars.find(
    (day) => day.market === input.instrument.market && day.tradingDate === marketDate(now, input.instrument.market),
  );
  const assess = (reason: DataBlocker | null) => {
    if (reason) blockers.add(reason);
  };
  if (account && !account.available) blockers.add('ACCOUNT_UNAVAILABLE');
  if (
    input.calendar &&
    (input.calendar.previousBusinessDay.tradingDate >= input.calendar.today.tradingDate ||
      input.calendar.today.tradingDate >= input.calendar.nextBusinessDay.tradingDate ||
      calendars.some((day) => day.market !== input.instrument.market))
  )
    blockers.add('INVALID_DATA');
  assess(observationBlocker(input.calendarObservedAt, input.asOf, marketDataPolicy.calendarMaxAgeMs, 'CALENDAR_STALE'));
  if (account)
    assess(observationBlocker(account.observedAt, input.asOf, marketDataPolicy.accountMaxAgeMs, 'ACCOUNT_STALE'));
  assess(observationBlocker(input.candlesObservedAt, input.asOf, marketDataPolicy.calendarMaxAgeMs, 'CANDLES_STALE'));
  assess(observationBlocker(input.quoteObservedAt, input.asOf, marketDataPolicy.quoteMaxAgeMs, 'QUOTE_STALE'));
  assess(
    input.quoteTimestamp === null
      ? 'QUOTE_TIME_MISSING'
      : observationBlocker(input.quoteTimestamp, input.asOf, marketDataPolicy.quoteMaxAgeMs, 'QUOTE_STALE'),
  );
  if (!currentDay) blockers.add('CALENDAR_MISSING');
  else if (!currentDay.sessionsKnown) blockers.add('CALENDAR_UNKNOWN');
  else if (!validMarketDay(currentDay)) blockers.add('INVALID_DATA');
  else if (
    !currentDay.sessions.some(
      (session) =>
        session.type === 'regular' && now >= Date.parse(session.startsAt) && now < Date.parse(session.endsAt),
    )
  )
    blockers.add('MARKET_CLOSED');
  const fxStart = Date.parse(input.exchangeRate.validFrom);
  const fxEnd = Date.parse(input.exchangeRate.validUntil);
  if (
    !instantSchema.safeParse(input.exchangeRate.validFrom).success ||
    !instantSchema.safeParse(input.exchangeRate.validUntil).success ||
    !Number.isFinite(fxStart) ||
    !Number.isFinite(fxEnd) ||
    fxStart >= fxEnd
  )
    blockers.add('INVALID_DATA');
  else if (now < fxStart || now >= fxEnd) blockers.add('FX_EXPIRED');
  if (input.restricted) blockers.add('INSTRUMENT_RESTRICTED');
  const assessments = input.candles.map((candle) =>
    assessCandle(candle, {
      asOf: input.asOf,
      observedAt: input.candlesObservedAt,
      day:
        calendars.find((day) => day.market === candle.instrument.market && day.tradingDate === candle.tradingDate) ??
        null,
      nxtSupported: input.nxtSupported,
    }),
  );
  let previous = -Infinity;
  for (const candle of input.candles) {
    if (
      candle.instrument.market !== input.instrument.market ||
      candle.instrument.symbol !== input.instrument.symbol ||
      Date.parse(candle.timestamp) <= previous ||
      candle.interval !== input.candles[0]?.interval ||
      candle.adjusted !== input.candles[0]?.adjusted ||
      candle.source !== input.candles[0]?.source
    )
      blockers.add('INVALID_DATA');
    previous = Date.parse(candle.timestamp);
  }
  if (assessments.some((assessment) => assessment.reason === 'INVALID_DATA' || assessment.reason === 'FUTURE_DATA'))
    blockers.add('INVALID_DATA');
  const closed = assessments
    .filter((assessment) => assessment.status === 'closed')
    .map((assessment) => assessment.candle);
  const latest = closed.at(-1);
  if (!latest) blockers.add('NO_CLOSED_CANDLES');
  else if (latest.interval === '1m' && now - Date.parse(latest.timestamp) >= marketDataPolicy.candleMaxLagMs)
    blockers.add('CANDLES_STALE');
  else if (latest.interval === '1d' && latest.tradingDate !== input.calendar?.previousBusinessDay.tradingDate)
    blockers.add('CANDLES_STALE');
  const validUntil = blockers.size
    ? null
    : new Date(
        Math.min(
          account ? Date.parse(account.observedAt) + marketDataPolicy.accountMaxAgeMs : Infinity,
          Date.parse(input.quoteObservedAt) + marketDataPolicy.quoteMaxAgeMs,
          Date.parse(input.quoteTimestamp!) + marketDataPolicy.quoteMaxAgeMs,
          Date.parse(input.calendarObservedAt!) + marketDataPolicy.calendarMaxAgeMs,
          Date.parse(input.candlesObservedAt) + marketDataPolicy.calendarMaxAgeMs,
          fxEnd,
          Date.parse(currentDay!.sessions.find((session) => session.type === 'regular')!.endsAt),
          latest!.interval === '1m' ? Date.parse(latest!.timestamp) + marketDataPolicy.candleMaxLagMs : Infinity,
        ),
      ).toISOString();
  return {
    ready: blockers.size === 0,
    blockers: [...blockers],
    candles: blockers.size ? [] : closed,
    assessments,
    validUntil,
  };
}
