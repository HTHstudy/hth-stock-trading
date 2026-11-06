import { expect, it } from 'vitest';
import type { Candle } from '@hth/contracts';
import type { StrategyContext } from './types.js';
import { meanReversion } from './mean-reversion.js';

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

const config = { period: 2, entryDeviationBps: '100' };
const evaluate = (input: StrategyContext) => meanReversion.evaluate(input, config);

it('연구 플러그인 식별자와 자체 warmup을 유지한다', () => {
  expect([meanReversion.id, meanReversion.version]).toEqual(['mean-reversion', '1.0.0']);
  for (const prices of [[], ['100'], ['100', '100']])
    expect(evaluate(context(prices))).toEqual({ action: 'HOLD', reason: 'WARMUP' });
  expect(meanReversion.evaluate(context(['100', '100', '98']), { ...config, period: 3 }).reason).toBe('WARMUP');
  for (const bad of [
    { ...config, period: 1 },
    { ...config, entryDeviationBps: '10000' },
  ])
    expect(() => meanReversion.evaluate(context([]), bad)).toThrow('INVALID_STRATEGY_CONFIG');
});

it('현재 봉을 평균에서 제외하고 편차 미만 진입과 평균 이상 청산을 구분한다', () => {
  expect(evaluate(context(['100', '100', '98.9']))).toEqual({ action: 'BUY', reason: 'BELOW_ENTRY_DEVIATION' });
  expect(evaluate(context(['100', '100', '99']))).toEqual({ action: 'HOLD', reason: 'NO_REVERSION_SIGNAL' });
  for (const close of ['100', '101'])
    expect(evaluate(context(['99', '101', close], '0.1'))).toEqual({ action: 'SELL', reason: 'MEAN_REVERSION' });
  for (const [prices, owned] of [
    [['100', '100', '98'], '1'],
    [['100', '100', '101'], '0'],
    [['100', '100', '99'], '1'],
  ] as const)
    expect(evaluate(context([...prices], owned))).toEqual({ action: 'HOLD', reason: 'NO_REVERSION_SIGNAL' });
});

it('작은 편차와 고정밀 가격을 반올림하지 않는다', () => {
  const low = '9007199254740993.00000000000';
  const high = '9007199254740993.00000000001';
  const exact = { period: 2, entryDeviationBps: '0.0000000000000000000000000001' };
  expect(meanReversion.evaluate(context([high, high, low]), exact).action).toBe('BUY');
  expect(meanReversion.evaluate(context([low, low, high], '1'), exact).action).toBe('SELL');
  // Three-bar average is recurring; compare scaled sums without rounding it.
  expect(meanReversion.evaluate(context(['1', '1', '2', '1.32']), { period: 3, entryDeviationBps: '100' }).action).toBe(
    'HOLD',
  );
  expect(
    meanReversion.evaluate(context(['1', '1', '2', '1.319999999999999999999999999']), {
      period: 3,
      entryDeviationBps: '100',
    }).action,
  ).toBe('BUY');
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
