import { describe, expect, it } from 'vitest';
import type { Candle, HistoricalRequest, MarketDay } from '@hth/contracts';
import { buildHistoricalDataset, historicalDates } from './historical.js';

const request: HistoricalRequest = {
  instrument: { market: 'KR', symbol: '005930' },
  interval: '1d',
  adjusted: false,
  from: '2026-03-25',
  to: '2026-03-25',
  source: 'toss',
};
const day: MarketDay = {
  market: 'KR',
  tradingDate: request.from,
  sessionsKnown: true,
  sessions: [{ type: 'regular', startsAt: '2026-03-25T09:00:00+09:00', endsAt: '2026-03-25T15:30:00+09:00' }],
};
const candle: Candle = {
  instrument: request.instrument,
  interval: '1d',
  timestamp: '2026-03-25T00:00:00+09:00',
  tradingDate: request.from,
  open: '100',
  high: '120',
  low: '90',
  close: '110',
  volume: '10',
  currency: 'KRW',
  adjusted: false,
  source: 'toss',
  isClosed: false,
};
const observedAt = '2026-03-26T00:00:00Z';
const input = {
  request,
  instrument: { name: 'Samsung', currency: 'KRW' as const, nxtSupportedAtCollection: true },
  calendars: [{ day, observedAt }],
  observations: [{ candle, observedAt, page: 1 }],
  startedAt: observedAt,
  completedAt: observedAt,
};

describe('과거 데이터셋 구성', () => {
  it('정규 세션 종료 증거와 일별 커버리지를 동결한다', () => {
    const dataset = buildHistoricalDataset(input);
    expect(dataset.coverage).toMatchObject({
      complete: true,
      days: [{ expectedBars: 1, observedBars: 1, status: 'complete' }],
    });
    expect(dataset.candles[0]?.isClosed).toBe(true);
    expect(dataset.observations[0]?.candle.isClosed).toBe(false);
    expect(dataset.pointInTime).toBe(false);
  });
  it('누락·휴장·미확인 캘린더를 구분한다', () => {
    expect(buildHistoricalDataset({ ...input, observations: [] }).coverage).toMatchObject({
      complete: false,
      days: [{ missingBars: 1, status: 'missing' }],
    });
    expect(
      buildHistoricalDataset({ ...input, observations: [], calendars: [{ day: { ...day, sessions: [] }, observedAt }] })
        .coverage.days[0]?.status,
    ).toBe('holiday');
    expect(
      buildHistoricalDataset({ ...input, calendars: [{ day: { ...day, sessionsKnown: false }, observedAt }] }).coverage
        .complete,
    ).toBe(false);
    expect(() => buildHistoricalDataset({ ...input, calendars: [] })).toThrow('CALENDAR_RANGE_MISMATCH');
  });
  it('겹치는 페이지는 후속 관측을 사용하고 원본 둘을 보존한다', () => {
    const dataset = buildHistoricalDataset({
      ...input,
      observations: [...input.observations, { candle: { ...candle, close: '115' }, observedAt, page: 2 }],
    });
    expect(dataset.candles).toHaveLength(1);
    expect(dataset.candles[0]?.close).toBe('115');
    expect(dataset.observations).toHaveLength(2);
    expect(() =>
      buildHistoricalDataset({
        ...input,
        observations: [...input.observations, { candle: { ...candle, close: '115' }, observedAt, page: 1 }],
      }),
    ).toThrow('CONFLICTING_PAGE_CANDLE');
  });
  it('종목·가격·관측 시각 오류를 통과시키지 않는다', () => {
    expect(() =>
      buildHistoricalDataset({
        ...input,
        observations: [{ candle: { ...candle, source: 'other' }, observedAt, page: 1 }],
      }),
    ).toThrow('HISTORICAL_CANDLE_MISMATCH');
    expect(
      buildHistoricalDataset({ ...input, observations: [{ candle: { ...candle, close: '999' }, observedAt, page: 1 }] })
        .coverage,
    ).toMatchObject({ complete: false, invalidBars: 1 });
    expect(() => buildHistoricalDataset({ ...input, startedAt: '2026-03-27T00:00:00Z' })).toThrow();
  });
  it('현재 NXT 지원 여부로 과거 마지막 분봉의 대기 시간을 단축하지 않는다', () => {
    const at = '2026-03-25T15:40:00+09:00';
    const dataset = buildHistoricalDataset({
      ...input,
      request: { ...request, interval: '1m' },
      startedAt: at,
      completedAt: at,
      calendars: [{ day, observedAt: at }],
      observations: [
        { candle: { ...candle, interval: '1m', timestamp: '2026-03-25T15:30:00+09:00' }, observedAt: at, page: 1 },
      ],
    });
    expect(dataset.coverage).toMatchObject({ complete: false, pendingBars: 1, days: [{ status: 'unsettled' }] });
  });
  it('분봉을 채워 넣지 않고 세션에서 예상되는 개수와 비교한다', () => {
    const shortDay = {
      ...day,
      sessions: [
        { type: 'regular' as const, startsAt: '2026-03-25T09:00:00+09:00', endsAt: '2026-03-25T09:02:00+09:00' },
      ],
    };
    const dataset = buildHistoricalDataset({
      ...input,
      request: { ...request, interval: '1m' },
      calendars: [{ day: shortDay, observedAt }],
      observations: [
        { candle: { ...candle, interval: '1m', timestamp: '2026-03-25T09:01:00+09:00' }, observedAt, page: 1 },
      ],
    });
    expect(dataset.coverage.days[0]).toMatchObject({
      expectedBars: 2,
      observedBars: 1,
      missingBars: 1,
      status: 'missing',
    });
  });
  it('날짜 범위는 양끝 포함 최대 366일로 제한한다', () => {
    expect(historicalDates({ ...request, to: '2026-03-27' })).toEqual(['2026-03-25', '2026-03-26', '2026-03-27']);
    expect(() => historicalDates({ ...request, to: '2028-01-01' })).toThrow('INVALID_HISTORICAL_REQUEST');
    expect(() => historicalDates({ ...request, to: '2026-03-24' })).toThrow('INVALID_HISTORICAL_REQUEST');
  });
  it('미국 현지 일봉을 처리하고 무체결 분봉 누락은 임의로 채우지 않는다', () => {
    const usRequest: HistoricalRequest = { ...request, instrument: { market: 'US', symbol: 'AAPL' } };
    const usDay: MarketDay = {
      market: 'US',
      tradingDate: request.from,
      sessionsKnown: true,
      sessions: [{ type: 'regular', startsAt: '2026-03-25T09:30:00-04:00', endsAt: '2026-03-25T09:32:00-04:00' }],
    };
    const usCandle: Candle = {
      ...candle,
      instrument: usRequest.instrument,
      currency: 'USD',
      timestamp: '2026-03-25T00:00:00-04:00',
    };
    const usInput = {
      ...input,
      request: usRequest,
      instrument: { name: 'Apple', currency: 'USD' as const, nxtSupportedAtCollection: null },
      calendars: [{ day: usDay, observedAt }],
      observations: [{ candle: usCandle, observedAt, page: 1 }],
    };
    expect(buildHistoricalDataset(usInput).coverage.complete).toBe(true);
    const minutes = buildHistoricalDataset({
      ...usInput,
      request: { ...usRequest, interval: '1m' },
      observations: [
        { candle: { ...usCandle, interval: '1m', timestamp: '2026-03-25T09:31:00-04:00' }, observedAt, page: 1 },
      ],
    });
    expect(minutes.coverage).toMatchObject({ complete: false, days: [{ missingBars: 1 }] });
    expect(minutes.warnings).toContain('US_GAPS_MAY_BE_NO_TRADES');
  });
});
