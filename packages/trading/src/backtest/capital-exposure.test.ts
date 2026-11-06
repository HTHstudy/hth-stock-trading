import { Decimal } from 'decimal.js';
import { expect, it } from 'vitest';
import { testDataset } from '../../test/dataset.js';
import { runBacktest } from './engine.js';
import type { BacktestReport } from './engine.js';
import { calculateCapitalExposure } from './capital-exposure.js';

const Money = Decimal.clone({ precision: 1000 });
const start = Date.parse('2026-03-06T14:00:00Z');
const time = (offset: number) => new Date(start + offset).toISOString();
function report(end = 1000, events: [number, 'BUY' | 'SELL', string, string?, string?][] = []): BacktestReport {
  const result = runBacktest({
    dataset: testDataset([{ open: 10, close: 10 }]),
    strategy: { id: 'fixture', version: '1', evaluate: () => ({ action: 'HOLD', reason: 'TEST' }) },
    strategyConfig: {},
    config: {
      initialCash: '1000',
      quantity: '1',
      priceTick: '1',
      buyFeeBps: '0',
      sellFeeBps: '0',
      sellTaxBps: '0',
      slippageBps: '0',
    },
  });
  let cash = new Money(1000);
  let quantity = '0';
  let cost = new Money(0);
  let realized = new Money(0);
  let fees = new Money(0);
  const taxes = new Money(0);
  for (const [at, action, price, fee = '0', size = '1'] of events) {
    const notional = new Money(price).mul(size);
    if (action === 'BUY') cost = notional.plus(fee);
    else {
      realized = realized.plus(notional).minus(fee).minus(cost);
      cost = new Money(0);
    }
    cash = action === 'BUY' ? cash.minus(notional).minus(fee) : cash.plus(notional).minus(fee);
    fees = fees.plus(fee);
    quantity = action === 'BUY' ? size : '0';
    result.fills.push({
      signalIndex: 0,
      action,
      timestamp: time(at),
      barTimestamp: time(at),
      referencePrice: price,
      price,
      quantity: size,
      notional: notional.toFixed(),
      fee,
      tax: '0',
      cashAfter: cash.toFixed(),
    });
  }
  const ending = cash.plus(new Money(quantity).mul(events.at(-1)?.[2] ?? '10'));
  const pnl = ending.minus(1000).toFixed();
  result.equity = [
    { timestamp: time(0), kind: 'initial', equity: '1000', cash: '1000', quantity: '0', cumulativeReturnPct: '0' },
    {
      timestamp: time(end),
      kind: 'close',
      equity: ending.toFixed(),
      cash: cash.toFixed(),
      quantity,
      cumulativeReturnPct: '0',
    },
  ];
  Object.assign(result.metrics, {
    endingCash: cash.toFixed(),
    endingQuantity: quantity,
    endingEquity: ending.toFixed(),
    netPnl: pnl,
    realizedPnl: realized.toFixed(),
    unrealizedPnl: ending.minus(cash).minus(cost).toFixed(),
    fillCount: events.length,
    totalFees: fees.toFixed(),
    totalTax: taxes.toFixed(),
  });
  return result;
}
it('장중 실제 체결 시각과 매수 수수료 포함 원가를 사용하며 정확한 필드만 반환한다', () => {
  expect(
    calculateCapitalExposure(
      report(1000, [
        [200, 'BUY', '100', '1'],
        [700, 'SELL', '112', '1'],
      ]),
    ),
  ).toEqual({
    model: 'acquisition-cost-calendar-time-v1',
    windowStartAt: time(0),
    windowEndAt: time(1000),
    windowMilliseconds: 1000,
    holdingMilliseconds: 500,
    holdingPct: '50.0000000000',
    maxInvestedCapital: '101',
    averageInvestedCapital: '50.5000000000',
    netPnlOverMaxInvestedCapitalPct: '9.9009900990',
    totalBuyNotional: '100',
    totalSellNotional: '112',
  });
});
it('야간과 주말 휴장을 달력 시간으로 포함하고 미청산도 마지막 equity까지 적분한다', () => {
  const end = 3 * 86_400_000;
  const result = calculateCapitalExposure(report(end, [[1000, 'BUY', '100']]));
  expect(result.holdingMilliseconds).toBe(end - 1000);
  expect(result.averageInvestedCapital).toBe('99.9996141975');
});
it('여러 왕복의 원가를 초기화하며 동일 시각 체결 순서를 유지하고 끝점 가중치는 0이다', () => {
  const result = calculateCapitalExposure(
    report(1000, [
      [0, 'BUY', '100'],
      [250, 'SELL', '110'],
      [250, 'BUY', '200'],
      [750, 'SELL', '210'],
      [1000, 'BUY', '300'],
    ]),
  );
  expect(result).toMatchObject({
    holdingMilliseconds: 750,
    holdingPct: '75.0000000000',
    maxInvestedCapital: '300',
    averageInvestedCapital: '125.0000000000',
    totalBuyNotional: '600',
    totalSellNotional: '320',
    netPnlOverMaxInvestedCapitalPct: '6.6666666667',
  });
});
it('무체결과 한 지점의 0초 구간을 구별하고 0초 비율은 null이다', () => {
  expect(calculateCapitalExposure(report())).toMatchObject({
    holdingPct: '0.0000000000',
    averageInvestedCapital: '0.0000000000',
    netPnlOverMaxInvestedCapitalPct: null,
  });
  const single = report(0);
  single.equity.pop();
  expect(calculateCapitalExposure(single)).toMatchObject({
    windowMilliseconds: 0,
    holdingPct: '0',
    netPnlOverMaxInvestedCapitalPct: null,
  });
  expect(calculateCapitalExposure(report(0, [[0, 'BUY', '10']]))).toMatchObject({
    maxInvestedCapital: '10',
    holdingMilliseconds: 0,
    averageInvestedCapital: '0.0000000000',
    netPnlOverMaxInvestedCapitalPct: null,
  });
});
it('십진 곱셈과 큰 정밀도를 유지한다', () => {
  const result = calculateCapitalExposure(report(3, [[1, 'BUY', '0.1', '0.01', '0.3']]));
  expect(result).toMatchObject({
    totalBuyNotional: '0.03',
    maxInvestedCapital: '0.04',
    averageInvestedCapital: '0.0266666667',
    holdingPct: '66.6666666667',
    netPnlOverMaxInvestedCapitalPct: '-25.0000000000',
  });
  const digits = '1234567891'.repeat(19);
  const exactProduct = `0.${(BigInt(digits) ** 2n).toString().padStart(380, '0')}`;
  expect(
    calculateCapitalExposure(report(1000, [[1, 'BUY', `0.${digits}`, '0', `0.${digits}`]])).maxInvestedCapital,
  ).toBe(exactProduct);
  const tiny = `0.${'0'.repeat(350)}1`;
  expect(calculateCapitalExposure(report(1000, [[1, 'BUY', tiny, '0', '0.3']])).totalBuyNotional).toBe(
    `0.${'0'.repeat(351)}3`,
  );
});
it('불일치 입력은 전용 오류로 거부한다', () => {
  const mutations: ((value: BacktestReport) => void)[] = [
    (value) => {
      value.equity = [];
    },
    (value) => {
      value.equity[0]!.quantity = '1';
    },
    (value) => {
      value.equity[0]!.kind = 'open';
    },
    (value) => {
      value.equity[1]!.timestamp = 'invalid';
    },
    (value) => {
      value.equity[1]!.timestamp = time(-1);
    },
    (value) => {
      value.fills[0]!.timestamp = time(-1);
    },
    (value) => {
      value.fills[0]!.timestamp = time(1001);
    },
    (value) => {
      value.fills[0]!.price = '0';
    },
    (value) => {
      value.fills[0]!.quantity = '-1';
    },
    (value) => {
      value.fills[0]!.notional = '11';
    },
    (value) => {
      value.fills[0]!.fee = '-1';
    },
    (value) => {
      value.fills[0]!.tax = '-1';
    },
    (value) => {
      value.fills[1]!.quantity = '0.5';
      value.fills[1]!.notional = '5';
    },
    (value) => {
      value.fills[1]!.action = 'BUY';
    },
    (value) => {
      value.fills[0]!.action = 'SELL';
    },
    (value) => {
      value.fills[1]!.timestamp = time(99);
    },
    (value) => {
      value.metrics.endingQuantity = '1';
    },
    (value) => {
      value.equity[1]!.quantity = '1';
    },
    (value) => {
      value.metrics.netPnl = '1';
    },
    (value) => {
      value.metrics.endingCash = '1';
    },
    (value) => {
      value.metrics.endingEquity = '1';
    },
    (value) => {
      value.metrics.totalFees = '1';
    },
    (value) => {
      value.metrics.totalTax = '1';
    },
    (value) => {
      value.metrics.fillCount = 1;
    },
  ];
  for (const mutate of mutations) {
    const value = report(1000, [
      [100, 'BUY', '10'],
      [900, 'SELL', '10'],
    ]);
    mutate(value);
    expect(() => calculateCapitalExposure(value)).toThrow('INVALID_CAPITAL_EXPOSURE');
  }
});
