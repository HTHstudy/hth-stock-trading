import { describe, expect, it } from 'vitest';
import type { Candle, MarketDay } from '@hth/contracts';
import { assessCandle } from './candles.js';
import { prepareStrategyData } from './readiness.js';
import type { StrategyDataInput } from './readiness.js';

const day: MarketDay = {
  market: 'KR',
  tradingDate: '2026-03-25',
  sessionsKnown: true,
  sessions: [
    { type: 'pre', startsAt: '2026-03-25T08:00:00+09:00', endsAt: '2026-03-25T09:00:00+09:00' },
    { type: 'regular', startsAt: '2026-03-25T09:00:00+09:00', endsAt: '2026-03-25T15:30:00+09:00' },
    { type: 'after', startsAt: '2026-03-25T15:30:00+09:00', endsAt: '2026-03-25T20:00:00+09:00' },
  ],
};
const candle: Candle = {
  instrument: { market: 'KR', symbol: '005930' },
  interval: '1m',
  timestamp: '2026-03-25T09:31:00+09:00',
  tradingDate: '2026-03-25',
  open: '72000',
  high: '72100',
  low: '71900',
  close: '72050',
  volume: '0',
  currency: 'KRW',
  adjusted: false,
  source: 'toss',
  isClosed: true,
};
const context = { day, asOf: '2026-03-25T09:33:00+09:00', observedAt: '2026-03-25T09:33:00+09:00', nxtSupported: true };

describe('봉 종료 증거', () => {
  it('세션·대기 시간·재수집 시각을 함께 검사하고 기존 isClosed 플래그를 신뢰하지 않는다', () => {
    expect(assessCandle(candle, context)).toMatchObject({
      status: 'closed',
      candle: { isClosed: true },
      usableAt: '2026-03-25T00:32:00.000Z',
    });
    expect(
      assessCandle(candle, { ...context, asOf: '2026-03-25T09:31:30+09:00', observedAt: '2026-03-25T09:31:30+09:00' }),
    ).toMatchObject({ status: 'pending', reason: 'BAR_NOT_SETTLED', candle: { isClosed: false } });
    expect(assessCandle(candle, { ...context, observedAt: '2026-03-25T09:31:30+09:00' })).toMatchObject({
      status: 'pending',
      reason: 'BAR_NOT_REOBSERVED',
    });
    expect(assessCandle(candle, { ...context, day: null })).toMatchObject({
      status: 'blocked',
      reason: 'CALENDAR_MISSING',
    });
  });

  it('NXT 미지원 종목의 15:30 봉은 16:01 이후 재수집해야 종료로 인정한다', () => {
    const closing = { ...candle, timestamp: '2026-03-25T15:30:00+09:00' };
    expect(
      assessCandle(closing, {
        ...context,
        nxtSupported: false,
        asOf: '2026-03-25T15:40:00+09:00',
        observedAt: '2026-03-25T15:40:00+09:00',
      }),
    ).toMatchObject({ status: 'pending', reason: 'BAR_NOT_SETTLED' });
    expect(
      assessCandle(closing, {
        ...context,
        nxtSupported: false,
        asOf: '2026-03-25T16:01:00+09:00',
        observedAt: '2026-03-25T16:01:00+09:00',
      }),
    ).toMatchObject({ status: 'closed' });
    expect(assessCandle(closing, { ...context, nxtSupported: null, asOf: '2026-03-25T16:05:00+09:00' })).toMatchObject({
      reason: 'METADATA_MISSING',
    });
  });

  it('일봉은 자정 timestamp 대신 모든 제공 세션의 종료를 확인한다', () => {
    const daily = { ...candle, interval: '1d' as const, timestamp: '2026-03-25T00:00:00+09:00' };
    expect(
      assessCandle(daily, { ...context, asOf: '2026-03-25T16:01:00+09:00', observedAt: '2026-03-25T16:01:00+09:00' }),
    ).toMatchObject({ reason: 'BAR_NOT_SETTLED' });
    expect(
      assessCandle(daily, { ...context, asOf: '2026-03-25T20:01:00+09:00', observedAt: '2026-03-25T20:01:00+09:00' }),
    ).toMatchObject({ status: 'closed' });
  });

  it.each([
    ['2026-03-25', '-04:00'],
    ['2026-11-02', '-05:00'],
  ])('미국 %s 세션의 DST 오프셋 %s를 처리한다', (date, offset) => {
    const usDay: MarketDay = {
      market: 'US',
      tradingDate: date,
      sessionsKnown: true,
      sessions: [
        { type: 'regular', startsAt: `${date}T09:30:00${offset}`, endsAt: `${date}T16:00:00${offset}` },
        { type: 'after', startsAt: `${date}T16:00:00${offset}`, endsAt: `${date}T20:00:00${offset}` },
      ],
    };
    const us = {
      ...candle,
      instrument: { market: 'US' as const, symbol: 'AAPL' },
      currency: 'USD' as const,
      tradingDate: date,
      timestamp: `${date}T09:31:00${offset}`,
    };
    expect(
      assessCandle(us, {
        day: usDay,
        asOf: `${date}T09:33:00${offset}`,
        observedAt: `${date}T09:33:00${offset}`,
        nxtSupported: null,
      }).status,
    ).toBe('closed');
    expect(
      assessCandle(
        { ...us, interval: '1d', timestamp: `${date}T00:00:00${offset}` },
        { day: usDay, asOf: `${date}T16:30:00${offset}`, observedAt: `${date}T16:30:00${offset}`, nxtSupported: null },
      ).status,
    ).toBe('pending');
  });

  it('휴장·미제공 캘린더·시간외 봉을 전략용에서 제외한다', () => {
    expect(assessCandle(candle, { ...context, day: { ...day, sessions: [] } }).reason).toBe('MARKET_CLOSED');
    expect(assessCandle(candle, { ...context, day: { ...day, sessionsKnown: false } }).reason).toBe('CALENDAR_UNKNOWN');
    expect(assessCandle({ ...candle, timestamp: '2026-03-25T08:31:00+09:00' }, context).reason).toBe(
      'OUTSIDE_REGULAR_SESSION',
    );
  });

  it('미국 조기 폐장도 고정 종료 시각 대신 제공 세션으로 판단한다', () => {
    const usDay: MarketDay = {
      market: 'US',
      tradingDate: '2026-11-27',
      sessionsKnown: true,
      sessions: [{ type: 'regular', startsAt: '2026-11-27T09:30:00-05:00', endsAt: '2026-11-27T13:00:00-05:00' }],
    };
    const us = {
      ...candle,
      instrument: { market: 'US' as const, symbol: 'AAPL' },
      currency: 'USD' as const,
      tradingDate: usDay.tradingDate,
      timestamp: '2026-11-27T13:00:00-05:00',
    };
    expect(
      assessCandle(us, {
        day: usDay,
        asOf: '2026-11-27T13:01:00-05:00',
        observedAt: '2026-11-27T13:01:00-05:00',
        nxtSupported: null,
      }).status,
    ).toBe('closed');
    expect(
      assessCandle(
        { ...us, timestamp: '2026-11-27T13:01:00-05:00' },
        { day: usDay, asOf: '2026-11-27T13:03:00-05:00', observedAt: '2026-11-27T13:03:00-05:00', nxtSupported: null },
      ).reason,
    ).toBe('OUTSIDE_REGULAR_SESSION');
  });

  it('미래 시각·잘못된 OHLC·거래일·중첩 세션을 차단한다', () => {
    expect(assessCandle({ ...candle, timestamp: '2026-03-25T10:00:00+09:00' }, context).reason).toBe('FUTURE_DATA');
    expect(assessCandle({ ...candle, high: '1' }, context).reason).toBe('INVALID_DATA');
    expect(assessCandle({ ...candle, tradingDate: '2026-03-24' }, context).reason).toBe('CALENDAR_MISSING');
    expect(
      assessCandle(candle, { ...context, day: { ...day, sessions: [...day.sessions, day.sessions[0]!] } }).reason,
    ).toBe('INVALID_DATA');
  });
});

function validInput(): StrategyDataInput {
  return {
    instrument: candle.instrument,
    nxtSupported: true,
    restricted: false,
    candles: [candle],
    candlesObservedAt: context.observedAt,
    quoteTimestamp: '2026-03-25T09:32:30+09:00',
    quoteObservedAt: context.observedAt,
    accountObservedAt: context.observedAt,
    accountAvailable: true,
    calendarObservedAt: context.observedAt,
    calendar: {
      today: day,
      previousBusinessDay: { ...day, tradingDate: '2026-03-24', sessions: [] },
      nextBusinessDay: { ...day, tradingDate: '2026-03-26', sessions: [] },
    },
    exchangeRate: { validFrom: '2026-03-25T09:33:00+09:00', validUntil: '2026-03-25T09:34:00+09:00' },
    asOf: context.asOf,
  };
}

describe('전략 입력 신선도 게이트', () => {
  it('조건을 모두 충족한 종료 봉만 전달하고 진행 봉은 제외한다', () => {
    const input = validInput();
    const result = prepareStrategyData({
      ...input,
      candles: [
        candle,
        { ...candle, timestamp: '2026-03-25T09:33:00+09:00' },
        { ...candle, timestamp: '2026-03-25T09:34:00+09:00' },
      ],
    });
    expect(result.ready).toBe(true);
    expect(result.candles).toHaveLength(1);
    expect(result.candles[0]?.isClosed).toBe(true);
    expect(result.validUntil).toBe('2026-03-25T00:34:00.000Z');
  });

  it.each([
    [{ quoteTimestamp: null }, 'QUOTE_TIME_MISSING'],
    [{ quoteTimestamp: '2026-03-25T09:30:00+09:00' }, 'QUOTE_STALE'],
    [{ accountObservedAt: '2026-03-25T09:31:00+09:00' }, 'ACCOUNT_STALE'],
    [{ calendarObservedAt: '2026-03-25T09:20:00+09:00' }, 'CALENDAR_STALE'],
    [{ accountObservedAt: '2026-03-25T10:00:00+09:00' }, 'FUTURE_DATA'],
    [{ restricted: true }, 'INSTRUMENT_RESTRICTED'],
    [{ accountAvailable: false }, 'ACCOUNT_UNAVAILABLE'],
  ] as const)('충족하지 못한 입력 %j는 %s로 차단한다', (patch, code) => {
    const result = prepareStrategyData({ ...validInput(), ...patch });
    expect(result.ready).toBe(false);
    expect(result.candles).toEqual([]);
    expect(result.blockers).toContain(code);
  });

  it('환율 유효 종료 경계와 시장 종료 시각에는 입력을 차단한다', () => {
    const input = validInput();
    expect(
      prepareStrategyData({
        ...input,
        exchangeRate: { validFrom: '2026-03-25T09:32:00+09:00', validUntil: input.asOf },
      }).blockers,
    ).toContain('FX_EXPIRED');
    expect(prepareStrategyData({ ...input, asOf: '2026-03-25T15:30:00+09:00' }).blockers).toContain('MARKET_CLOSED');
  });

  it('오래된 종료 봉·역순·중복·다른 종목·조정 방식 혼합을 차단한다', () => {
    const input = validInput();
    expect(
      prepareStrategyData({ ...input, candles: [{ ...candle, timestamp: '2026-03-25T09:01:00+09:00' }] }).blockers,
    ).toContain('CANDLES_STALE');
    expect(prepareStrategyData({ ...input, candles: [candle, candle] }).blockers).toContain('INVALID_DATA');
    expect(
      prepareStrategyData({ ...input, candles: [{ ...candle, instrument: { market: 'KR', symbol: '000660' } }] })
        .blockers,
    ).toContain('INVALID_DATA');
    expect(
      prepareStrategyData({
        ...input,
        candles: [candle, { ...candle, timestamp: '2026-03-25T09:32:00+09:00', adjusted: true }],
      }).blockers,
    ).toContain('INVALID_DATA');
  });
});
