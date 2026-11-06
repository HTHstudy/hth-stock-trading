import { expect, it } from 'vitest';
import type { StrategyContext } from './types.js';
import { buyAndHold } from './buy-and-hold.js';

function context(count: number, ownedQuantity = '0'): StrategyContext {
  return {
    instrument: { market: 'US', symbol: 'AAPL' },
    evaluatedAt: '2026-03-09T15:00:00Z',
    ownedQuantity,
    closedCandles: Array.from({ length: count }, (_, index) => ({
      instrument: { market: 'US' as const, symbol: 'AAPL' },
      interval: '1m' as const,
      timestamp: new Date(Date.parse('2026-03-09T14:00:00Z') + index * 60_000).toISOString(),
      tradingDate: '2026-03-09',
      open: '10',
      high: '11',
      low: '9',
      close: '10',
      volume: '1',
      currency: 'USD' as const,
      adjusted: false,
      source: 'test',
      isClosed: true,
    })),
  };
}
it('연구 기준 전략은 N번째 종료 봉의 무보유 상태에서만 진입한다', () => {
  expect([buyAndHold.id, buyAndHold.version]).toEqual(['buy-and-hold', '1.0.0']);
  const config = { entryAfterClosedCandles: 2 };
  expect(buyAndHold.evaluate(context(0), config)).toEqual({ action: 'HOLD', reason: 'WARMUP' });
  expect(buyAndHold.evaluate(context(1), config).reason).toBe('WARMUP');
  expect(buyAndHold.evaluate(context(2), config)).toEqual({ action: 'BUY', reason: 'BENCHMARK_ENTRY' });
  for (const [count, owned] of [
    [2, '1'],
    [3, '0'],
    [3, '1'],
  ] as const)
    expect(buyAndHold.evaluate(context(count, owned), config)).toEqual({ action: 'HOLD', reason: 'BENCHMARK_HOLD' });
  expect(buyAndHold.evaluate(context(1), { entryAfterClosedCandles: 1 }).action).toBe('BUY');
});
it('부족 자금 또는 실패 뒤 다음 봉에서 재진입하지 않고 미래 봉이 이전 판단을 바꾸지 않는다', () => {
  const initial = context(2);
  const before = buyAndHold.evaluate(initial, { entryAfterClosedCandles: 2 });
  expect(buyAndHold.evaluate(context(3), { entryAfterClosedCandles: 2 }).action).toBe('HOLD');
  expect(buyAndHold.evaluate(initial, { entryAfterClosedCandles: 2 })).toEqual(before);
});
it('선택한 봉의 종료·종목·시각·OHLC와 보유량을 warmup에서도 검증한다', () => {
  const mutations: ((value: StrategyContext) => StrategyContext)[] = [
    (value) => ({ ...value, ownedQuantity: '-1' }),
    (value) => ({ ...value, evaluatedAt: 'invalid' }),
    ...[
      { isClosed: false },
      { instrument: { market: 'US' as const, symbol: 'MSFT' } },
      { timestamp: 'invalid' },
      { timestamp: '2026-03-10T00:00:00Z' },
      { low: '0' },
      { close: '12' },
      { high: '8' },
      { open: 'NaN' },
      { close: '1e1' },
    ].map((patch) => (value: StrategyContext) => ({
      ...value,
      closedCandles: [{ ...value.closedCandles[0]!, ...patch }],
    })),
  ];
  for (const mutate of mutations)
    expect(() => buyAndHold.evaluate(mutate(context(1)), { entryAfterClosedCandles: 2 })).toThrow(
      'INVALID_STRATEGY_DATA',
    );
  const value = context(2);
  expect(() =>
    buyAndHold.evaluate(
      { ...value, closedCandles: [value.closedCandles[0]!, value.closedCandles[0]!] },
      { entryAfterClosedCandles: 2 },
    ),
  ).toThrow('INVALID_STRATEGY_DATA');
  expect(() => buyAndHold.evaluate(value, { entryAfterClosedCandles: 0 })).toThrow('INVALID_STRATEGY_CONFIG');
});
it('안전 정수 범위 밖의 십진 가격과 작은 보유량도 정확히 다룬다', () => {
  const value = context(1, '0.00000000000000000001');
  const price = '9007199254740993.00000000001';
  const closedCandles = value.closedCandles.map((bar) => ({
    ...bar,
    open: price,
    high: price,
    low: price,
    close: price,
  }));
  expect(buyAndHold.evaluate({ ...value, closedCandles }, { entryAfterClosedCandles: 1 }).reason).toBe(
    'BENCHMARK_HOLD',
  );
});
