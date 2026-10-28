import { expect, it } from 'vitest';
import { paperRiskInputSchema } from '@hth/contracts';
import example from '../../../../examples/paper-risk-input.json' with { type: 'json' };
import { paperPortfolios } from './paper-portfolio.js';

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
