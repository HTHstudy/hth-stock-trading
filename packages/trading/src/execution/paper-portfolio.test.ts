import { expect, it } from 'vitest';
import { paperRiskInputSchema } from '@hth/contracts';
import example from '../../../../examples/paper-risk-input.json' with { type: 'json' };
import { paperPortfolios, paperEquityValues, paperEquityChange } from './paper-portfolio.js';

it('통화별 예약과 이미 지불한 올림 비용을 구분하고 통화를 합산하지 않는다', () => {
  const snapshot = paperRiskInputSchema.parse(example).snapshot!;
  snapshot.cash = { KRW: '9007199254740993', USD: '1' };
  snapshot.reservations = [
    {
      intentId: 'partial',
      strategyId: 'ma',
      instrument: { market: 'US', symbol: 'AAPL' },
      side: 'BUY',
      remainingQuantity: '1',
      limitPrice: '0.01',
      costBps: '10',
      filledNotional: '0.01',
      paidCosts: '0.01',
    },
  ];
  expect(paperPortfolios(snapshot)).toMatchObject([
    { currency: 'KRW', cash: '9007199254740993', availableCash: '9007199254740993' },
    { currency: 'USD', cash: '1', reservedCash: '0.01', availableCash: '0.99' },
  ]);
});
it('최초 기록 대비 자산 변동률은 십진 연산하고 기준이 0 이하면 미계산이다', () => {
  expect(paperEquityChange('14996', '15000')).toBe('-0.02666667');
  expect(paperEquityChange('1', '0')).toBeNull();
  expect(paperEquityChange('9007199254740994', '9007199254740993')).toBe('0.00000000');
  const snapshot = paperRiskInputSchema.parse(example).snapshot!;
  expect(paperEquityValues(snapshot)).toEqual(
    paperPortfolios(snapshot).map(({ currency, equity }) => ({ currency, equity })),
  );
});
