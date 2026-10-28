import { expect, it } from 'vitest';
import { paperLedgerStateSchema } from '@hth/contracts';
import { observePaperLedger } from './paper-observation.js';

function fixture(asOf = '2026-03-25T02:00:00Z') {
  const instrument = { market: 'KR' as const, symbol: '005930' };
  const ledger = paperLedgerStateSchema.parse({
    observedAt: asOf,
    reconciled: false,
    cash: { KRW: '15000', USD: '1000' },
    positions: [
      {
        instrument,
        quantity: '1',
        manualQuantity: '1',
        sellableQuantity: '1',
        ownership: [],
        markPrice: '1000',
        markTimestamp: asOf,
        markObservedAt: asOf,
      },
    ],
    dailyPnl: { KRW: { tradingDate: '2026-03-25', netPnl: '-500' }, USD: { tradingDate: '2026-03-25', netPnl: '0' } },
  });
  const observation = {
    sourcesHealthy: true,
    hasUnknownOrders: false,
    quotes: [{ instrument, price: '1010', timestamp: asOf, observedAt: asOf }],
  };
  return { ledger, observation, asOf };
}
it('평가만 갱신하며 현금·소유권과 기존 손실을 보존하고 같은 관측은 중복 손익을 만들지 않는다', () => {
  const { ledger, observation, asOf } = fixture();
  const original = structuredClone(ledger);
  const result = observePaperLedger(ledger, observation, asOf);
  expect(result).toMatchObject({ cash: ledger.cash, reconciled: true, dailyPnl: { KRW: { netPnl: '-490' } } });
  expect(result.positions[0]).toMatchObject({ quantity: '1', manualQuantity: '1', ownership: [] });
  expect(observePaperLedger(result, observation, asOf)).toEqual(result);
  expect(ledger).toEqual(original);
});
it('모든 보유분의 고유한 신선한 quote가 필요하고 원천 시각이 퇴행할 수 없다', () => {
  const { ledger, observation, asOf } = fixture();
  expect(() => observePaperLedger(ledger, { ...observation, quotes: [] }, asOf)).toThrow('PAPER_MARKS_MISMATCH');
  expect(() =>
    observePaperLedger(ledger, { ...observation, quotes: [...observation.quotes, ...observation.quotes] }, asOf),
  ).toThrow('PAPER_MARKS_MISMATCH');
  observation.quotes[0]!.timestamp = '2026-03-25T01:59:59Z';
  expect(() => observePaperLedger(ledger, observation, asOf)).toThrow('PAPER_OBSERVATION_STALE');
  observation.quotes[0]!.timestamp = '2026-03-25T02:03:00Z';
  expect(() => observePaperLedger(ledger, observation, asOf)).toThrow('PAPER_OBSERVATION_STALE');
});
it('연속 관측 중 거래일 전환은 직전 평가자산을 새 기준으로 삼는다', () => {
  const { ledger, observation } = fixture('2026-03-25T14:59:59Z');
  ledger.dailyPnl.USD.tradingDate = '2026-03-25';
  observation.quotes[0]!.timestamp = '2026-03-25T15:00:01Z';
  observation.quotes[0]!.observedAt = '2026-03-25T15:00:01Z';
  expect(observePaperLedger(ledger, observation, '2026-03-25T15:00:01Z').dailyPnl).toEqual({
    KRW: { tradingDate: '2026-03-26', netPnl: '10' },
    USD: { tradingDate: '2026-03-25', netPnl: '0' },
  });
});
it('장시간 중단 후 새 거래일과 잘못된 기존 날짜는 손실을 초기화하지 않고 검토를 요구한다', () => {
  const { ledger, observation } = fixture('2026-03-25T14:59:59Z');
  ledger.dailyPnl.USD.tradingDate = '2026-03-25';
  observation.quotes[0]!.timestamp = '2026-03-25T15:05:01Z';
  observation.quotes[0]!.observedAt = '2026-03-25T15:05:01Z';
  expect(() => observePaperLedger(ledger, observation, '2026-03-25T15:05:01Z')).toThrow(
    'PAPER_TRADING_DAY_REVIEW_REQUIRED',
  );
  ledger.dailyPnl.KRW.tradingDate = '2000-01-01';
  expect(() => observePaperLedger(ledger, observation, '2026-03-25T14:59:59Z')).toThrow();
});
