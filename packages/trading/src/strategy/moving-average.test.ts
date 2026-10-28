import { expect, it } from 'vitest';
import { testDataset } from '../../test/dataset.js';
import { movingAverageCross } from './moving-average.js';

function evaluate(prices: number[], fastPeriod = 1, slowPeriod = 2) {
  const dataset = testDataset(prices.map((price) => ({ open: price, close: price })));
  return movingAverageCross.evaluate(
    {
      instrument: dataset.request.instrument,
      evaluatedAt: dataset.completedAt,
      closedCandles: dataset.candles,
      ownedQuantity: '0',
    },
    { fastPeriod, slowPeriod },
  );
}
it('두 시점의 평균을 비교하기 위한 warm-up과 교차 방향을 구분한다', () => {
  expect(evaluate([2, 1]).reason).toBe('WARMUP');
  expect(evaluate([3, 2, 3]).action).toBe('BUY');
  expect(evaluate([1, 2, 1]).action).toBe('SELL');
  expect(evaluate([1, 2, 3]).action).toBe('HOLD');
  expect(evaluate([1, 1, 1]).action).toBe('HOLD');
  expect(evaluate([1, 1, 2]).action).toBe('BUY');
});
it('기간 오류를 거부하며 부동소수점으로 구별할 수 없는 가격도 정확히 비교한다', () => {
  expect(() => evaluate([1, 2, 3], 2, 2)).toThrow('INVALID_STRATEGY_CONFIG');
  const dataset = testDataset([2, 1, 2].map((price) => ({ open: price, close: price })));
  const prices = ['9007199254740993.00000000001', '9007199254740993.00000000000', '9007199254740993.00000000001'];
  expect(
    movingAverageCross.evaluate(
      {
        instrument: dataset.request.instrument,
        evaluatedAt: dataset.completedAt,
        closedCandles: dataset.candles.map((candle, index) => ({ ...candle, close: prices[index]! })),
        ownedQuantity: '0',
      },
      { fastPeriod: 1, slowPeriod: 2 },
    ).action,
  ).toBe('BUY');
});
