import { decimalSchema, instantSchema } from '@hth/contracts';
import type { Candle, MarketDay } from '@hth/contracts';
import { marketDataPolicy, marketDate, observationBlocker, validMarketDay } from './policy.js';
import type { CandleAssessment, DataBlocker } from './policy.js';

function compare(left: string, right: string) {
  const [leftWhole = '', leftFraction = ''] = left.split('.');
  const [rightWhole = '', rightFraction = ''] = right.split('.');
  const scale = Math.max(leftFraction.length, rightFraction.length);
  const leftValue = BigInt(leftWhole + leftFraction.padEnd(scale, '0'));
  const rightValue = BigInt(rightWhole + rightFraction.padEnd(scale, '0'));
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

export function assessCandle(
  candle: Candle,
  context: {
    readonly asOf: string;
    readonly observedAt: string;
    readonly day: MarketDay | null;
    readonly nxtSupported: boolean | null;
  },
): CandleAssessment {
  const result = (
    status: CandleAssessment['status'],
    reason: DataBlocker | null,
    usableAt: string | null = null,
  ): CandleAssessment => ({
    candle: { ...candle, isClosed: status === 'closed' },
    status,
    reason,
    usableAt,
  });
  const end = Date.parse(candle.timestamp);
  const asOf = Date.parse(context.asOf);
  const observed = Date.parse(context.observedAt);
  if (
    ![candle.timestamp, context.asOf, context.observedAt].every((value) => instantSchema.safeParse(value).success) ||
    !['1m', '1d'].includes(candle.interval) ||
    !['KR', 'US'].includes(candle.instrument.market) ||
    candle.currency !== (candle.instrument.market === 'KR' ? 'KRW' : 'USD') ||
    ![candle.open, candle.high, candle.low, candle.close, candle.volume].every(
      (value) => decimalSchema.max(30).safeParse(value).success && !value.startsWith('-'),
    )
  )
    return result('blocked', 'INVALID_DATA');
  if (
    compare(candle.low, candle.high) > 0 ||
    compare(candle.open, candle.low) < 0 ||
    compare(candle.open, candle.high) > 0 ||
    compare(candle.close, candle.low) < 0 ||
    compare(candle.close, candle.high) > 0
  )
    return result('blocked', 'INVALID_DATA');
  if (observationBlocker(context.observedAt, context.asOf, Number.MAX_SAFE_INTEGER, 'INVALID_DATA'))
    return result('blocked', 'FUTURE_DATA');
  if (
    (candle.interval === '1m' && end > asOf + 60_000 + marketDataPolicy.futureToleranceMs) ||
    (candle.interval === '1d' &&
      end > asOf + marketDataPolicy.futureToleranceMs &&
      candle.tradingDate !== marketDate(asOf, candle.instrument.market))
  )
    return result('blocked', 'FUTURE_DATA');
  const day = context.day;
  if (!day || day.market !== candle.instrument.market || day.tradingDate !== candle.tradingDate)
    return result('blocked', 'CALENDAR_MISSING');
  if (!day.sessionsKnown) return result('blocked', 'CALENDAR_UNKNOWN');
  if (!validMarketDay(day)) return result('blocked', 'INVALID_DATA');
  const regular = day.sessions.find((session) => session.type === 'regular');
  if (!regular) return result('blocked', 'MARKET_CLOSED');
  let windowEnd: number;
  if (candle.interval === '1m') {
    if (end % 60_000 !== 0 || marketDate(end, candle.instrument.market, true) !== candle.tradingDate)
      return result('blocked', 'INVALID_DATA');
    if (end - 60_000 < Date.parse(regular.startsAt) || end > Date.parse(regular.endsAt))
      return result('blocked', 'OUTSIDE_REGULAR_SESSION');
    windowEnd = end;
    if (candle.instrument.market === 'KR' && end === Date.parse(regular.endsAt)) {
      if (context.nxtSupported === null) return result('blocked', 'METADATA_MISSING');
      if (!context.nxtSupported)
        windowEnd = Math.max(end + 30 * 60_000, Date.parse(`${candle.tradingDate}T16:00:00+09:00`));
    }
  } else {
    const localMidnight = new Intl.DateTimeFormat('en-CA', {
      timeZone: candle.instrument.market === 'KR' ? 'Asia/Seoul' : 'America/New_York',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(end));
    if (
      marketDate(end, candle.instrument.market) !== candle.tradingDate ||
      localMidnight !== '00:00:00' ||
      end % 1000 !== 0
    )
      return result('blocked', 'INVALID_DATA');
    windowEnd = Math.max(...day.sessions.map((session) => Date.parse(session.endsAt)));
  }
  const usableAt = new Date(windowEnd + marketDataPolicy.settlementDelayMs).toISOString();
  if (asOf < Date.parse(usableAt)) return result('pending', 'BAR_NOT_SETTLED', usableAt);
  if (observed < Date.parse(usableAt)) return result('pending', 'BAR_NOT_REOBSERVED', usableAt);
  return result('closed', null, usableAt);
}
