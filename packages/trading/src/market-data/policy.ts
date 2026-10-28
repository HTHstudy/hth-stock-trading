import type { Candle, DataBlocker, Market, MarketDay } from '@hth/contracts';
import { instantSchema } from '@hth/contracts';
export type { DataBlocker } from '@hth/contracts';

export const marketDataPolicy = {
  version: 'market-data-v1',
  settlementDelayMs: 60_000,
  quoteMaxAgeMs: 120_000,
  accountMaxAgeMs: 60_000,
  calendarMaxAgeMs: 300_000,
  candleMaxLagMs: 180_000,
  futureToleranceMs: 5000,
} as const;

export interface CandleAssessment {
  readonly candle: Candle;
  readonly status: 'closed' | 'pending' | 'blocked';
  readonly reason: DataBlocker | null;
  readonly usableAt: string | null;
}

export function marketDate(timestamp: number, market: Market, minuteEnd = false) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: market === 'KR' ? 'Asia/Seoul' : 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(timestamp - (minuteEnd ? 1 : 0)));
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? '';
  const date = `${part('year')}-${part('month')}-${part('day')}`;
  return market === 'US' && Number(part('hour')) >= 20
    ? new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
    : date;
}

export function validMarketDay(day: MarketDay) {
  if (!day.sessionsKnown) return false;
  const sessions = [...day.sessions].sort((left, right) => Date.parse(left.startsAt) - Date.parse(right.startsAt));
  if (new Set(sessions.map((session) => session.type)).size !== sessions.length) return false;
  return sessions.every((session, index) => {
    const start = Date.parse(session.startsAt);
    const end = Date.parse(session.endsAt);
    const previous = sessions[index - 1];
    return (
      instantSchema.safeParse(session.startsAt).success &&
      instantSchema.safeParse(session.endsAt).success &&
      Number.isFinite(start) &&
      Number.isFinite(end) &&
      end > start &&
      end - start < 86_400_000 &&
      marketDate(start, day.market) === day.tradingDate &&
      marketDate(end - 1, day.market) === day.tradingDate &&
      (!previous || Date.parse(previous.endsAt) <= start)
    );
  });
}

export function observationBlocker(
  observedAt: string | null,
  asOf: string,
  maxAgeMs: number,
  stale: DataBlocker,
): DataBlocker | null {
  if (!observedAt) return stale;
  const observed = Date.parse(observedAt);
  const now = Date.parse(asOf);
  if (
    !instantSchema.safeParse(observedAt).success ||
    !instantSchema.safeParse(asOf).success ||
    !Number.isFinite(observed) ||
    !Number.isFinite(now)
  )
    return 'INVALID_DATA';
  if (observed > now + marketDataPolicy.futureToleranceMs) return 'FUTURE_DATA';
  return now - observed >= maxAgeMs ? stale : null;
}
