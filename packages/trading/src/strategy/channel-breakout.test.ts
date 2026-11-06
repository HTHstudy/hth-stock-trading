import { expect, it } from 'vitest';
import type { Candle } from '@hth/contracts';
import type { StrategyContext } from './types.js';
import { channelBreakout } from './channel-breakout.js';

function context(prices: string[], ownedQuantity = '0'): StrategyContext {
  const instrument = { market: 'US', symbol: 'TEST' } as const;
  return {
    instrument,
    evaluatedAt: '2026-01-02T00:00:00Z',
    ownedQuantity,
    closedCandles: prices.map((price, index): Candle => ({
      instrument,
      interval: '1m',
      timestamp: new Date(Date.parse('2026-01-01T00:00:00Z') + index * 60_000).toISOString(),
      tradingDate: '2026-01-01',
      open: price,
      high: price,
      low: price,
      close: price,
      volume: '1',
      currency: 'USD',
      adjusted: false,
      source: 'synthetic',
      isClosed: true,
    })),
  };
}

const config = { entryPeriod: 2, exitPeriod: 2 };
const evaluate = (input: StrategyContext) => channelBreakout.evaluate(input, config);

it('연구 플러그인 식별자와 자체 warmup을 유지한다', () => {
  expect([channelBreakout.id, channelBreakout.version]).toEqual(['channel-breakout', '1.0.0']);
  for (const prices of [[], ['100'], ['100', '100']])
    expect(evaluate(context(prices))).toEqual({ action: 'HOLD', reason: 'WARMUP' });
  expect(channelBreakout.evaluate(context(['100', '100', '101']), { entryPeriod: 3, exitPeriod: 2 }).reason).toBe(
    'WARMUP',
  );
  expect(() => channelBreakout.evaluate(context([]), { entryPeriod: 2, exitPeriod: 3 })).toThrow(
    'INVALID_STRATEGY_CONFIG',
  );
});

it('현재 봉을 채널에서 제외하고 strict 돌파를 flat/보유 상태로 구분한다', () => {
  expect(evaluate(context(['100', '101', '102']))).toEqual({ action: 'BUY', reason: 'CHANNEL_BREAKOUT' });
  expect(evaluate(context(['100', '101', '99'], '0.1'))).toEqual({ action: 'SELL', reason: 'CHANNEL_EXIT' });
  for (const [prices, owned] of [
    [['100', '101', '102'], '1'],
    [['100', '101', '99'], '0'],
    [['100', '101', '101'], '0'],
    [['100', '101', '100'], '1'],
  ] as const)
    expect(evaluate(context([...prices], owned))).toEqual({ action: 'HOLD', reason: 'NO_CHANNEL_SIGNAL' });
});

it('종가 대신 과거 고가/저가와 독립 청산 기간을 사용한다', () => {
  const base = context(['100', '100', '101']);
  expect(
    evaluate({ ...base, closedCandles: base.closedCandles.map((bar, i) => (i < 2 ? { ...bar, high: '102' } : bar)) })
      .action,
  ).toBe('HOLD');
  const owned = context(['100', '100', '99'], '1');
  expect(
    evaluate({ ...owned, closedCandles: owned.closedCandles.map((bar, i) => (i < 2 ? { ...bar, low: '98' } : bar)) })
      .action,
  ).toBe('HOLD');
  expect(
    channelBreakout.evaluate(context(['90', '100', '100', '95'], '1'), { entryPeriod: 3, exitPeriod: 2 }).action,
  ).toBe('SELL');
});

it('Number로 구별할 수 없는 소수 가격도 정확히 비교한다', () => {
  const low = '9007199254740993.00000000000';
  const high = '9007199254740993.00000000001';
  expect(evaluate(context([low, low, high])).action).toBe('BUY');
  expect(evaluate(context([high, high, low], '0.0000000000000000000000000001')).action).toBe('SELL');
});

it('잘못된 보유 수량은 warmup 전에도 거부한다', () => {
  for (const owned of ['-1', 'NaN', 'Infinity', '1e2', '', '1'.repeat(31), 1, null]) {
    expect(() => evaluate({ ...context([]), ownedQuantity: owned as string })).toThrow('INVALID_STRATEGY_DATA');
  }
});

it('선택한 모든 봉의 종목·확정·OHLC·시각을 검증한다', () => {
  const valid = context(['100', '100', '100']);
  const changes: Partial<Candle>[] = [
    { instrument: { market: 'KR', symbol: 'TEST' } },
    { instrument: { market: 'US', symbol: 'OTHER' } },
    { isClosed: false },
    { open: 'NaN' },
    { high: 'Infinity' },
    { low: '-1' },
    { close: '1e2' },
    { close: '1'.repeat(31) },
    { low: '0' },
    { high: '99' },
    { low: '101' },
    { open: '101' },
    { close: '99' },
    { timestamp: 'invalid' },
  ];
  for (const index of [0, 1, 2]) {
    for (const change of changes) {
      const closedCandles = valid.closedCandles.map((bar, i) => (i === index ? { ...bar, ...change } : bar));
      expect(() => evaluate({ ...valid, closedCandles })).toThrow('INVALID_STRATEGY_DATA');
    }
  }
  for (const timestamp of [valid.closedCandles[0]!.timestamp, '2025-12-31T23:59:00Z', '2026-01-01T09:00:00+09:00']) {
    const closedCandles = valid.closedCandles.map((bar, index) => (index === 1 ? { ...bar, timestamp } : bar));
    expect(() => evaluate({ ...valid, closedCandles })).toThrow('INVALID_STRATEGY_DATA');
  }
  expect(() => evaluate({ ...valid, closedCandles: [...valid.closedCandles].reverse() })).toThrow(
    'INVALID_STRATEGY_DATA',
  );
});

it('필요한 마지막 봉만 사용하며 입력을 변경하지 않는다', () => {
  const valid = context(['100', '100', '100', '100']);
  const closedCandles = valid.closedCandles.map((bar, index) =>
    Object.freeze(index === 0 ? { ...bar, isClosed: false } : bar),
  );
  const input = Object.freeze({ ...valid, closedCandles: Object.freeze(closedCandles) });
  const before = JSON.stringify(input);
  expect(evaluate(input).action).toBe('HOLD');
  expect(JSON.stringify(input)).toBe(before);
});
