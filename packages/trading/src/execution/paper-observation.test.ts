import { expect, it } from 'vitest';
import { paperLedgerStateSchema } from '@hth/contracts';
import type { InstrumentId } from '@hth/contracts';
import { observePaperLedger, reviewPaperTradingDay } from './paper-observation.js';

function fixture(asOf = '2026-03-25T02:00:00Z') {
  const instrument: InstrumentId = { market: 'KR', symbol: '005930' };
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
it('명시적 거래일 검토는 기존 손실과 중단 구간 평가 차이를 새 거래일로 이월한다', () => {
  const { ledger, observation } = fixture('2026-03-25T14:59:59Z');
  observation.quotes[0]!.timestamp = '2026-03-25T15:05:00Z';
  observation.quotes[0]!.observedAt = '2026-03-25T15:05:00Z';
  const result = reviewPaperTradingDay(ledger, observation, '2026-03-25T15:05:00Z');
  expect(result.dailyPnl.KRW).toEqual({ tradingDate: '2026-03-26', netPnl: '-490' });
  expect(result.cash).toEqual(ledger.cash);
  expect(result.positions[0]!.manualQuantity).toBe('1');
  ledger.dailyPnl.KRW.netPnl = '500';
  expect(reviewPaperTradingDay(ledger, observation, '2026-03-25T15:05:00Z').dailyPnl.KRW.netPnl).toBe('10');
});
it('거래일 검토로 오염된 날짜나 오래된 가격을 승인하지 않는다', () => {
  const { ledger, observation } = fixture('2026-03-25T14:59:59Z');
  expect(() => reviewPaperTradingDay(ledger, observation, '2026-03-25T15:05:00Z')).toThrow('PAPER_OBSERVATION_STALE');
  expect(() => reviewPaperTradingDay(ledger, observation, '2026-03-25T14:59:59Z')).toThrow(
    'PAPER_TRADING_DAY_REVIEW_NOT_REQUIRED',
  );
  observation.quotes[0]!.timestamp = '2026-03-25T15:05:00Z';
  observation.quotes[0]!.observedAt = '2026-03-25T15:05:00Z';
  ledger.dailyPnl.KRW.tradingDate = '2000-01-01';
  expect(() => reviewPaperTradingDay(ledger, observation, '2026-03-25T15:05:00Z')).toThrow(
    'PAPER_TRADING_DAY_REVIEW_REQUIRED',
  );
});

it.each([
  ['2026-03-25T23:59:59Z', '2026-03-26T00:00:01Z', '2026-03-26', '2026-03-25', '2026-03-26'],
  ['2026-01-25T00:59:59Z', '2026-01-25T01:00:01Z', '2026-01-25', '2026-01-24', '2026-01-25'],
])('미국 뉴욕 20시 경계를 DST에 맞춰 처리한다: %s', (before, after, krDate, previousDate, nextDate) => {
  const { ledger, observation } = fixture(before);
  ledger.dailyPnl.KRW.tradingDate = krDate;
  ledger.dailyPnl.USD = { tradingDate: previousDate, netPnl: '-50' };
  ledger.positions[0]!.instrument = { market: 'US', symbol: 'AAPL' };
  observation.quotes[0] = {
    ...observation.quotes[0]!,
    instrument: { market: 'US', symbol: 'AAPL' },
    timestamp: after,
    observedAt: after,
  };
  const result = observePaperLedger(ledger, observation, after);
  expect(result.dailyPnl.USD).toEqual({ tradingDate: nextDate, netPnl: '10' });
  expect(result.dailyPnl.KRW.netPnl).toBe('-500');
  expect(ledger.dailyPnl.USD.netPnl).toBe('-50');
  const later = new Date(Date.parse(after) + 300000).toISOString();
  observation.quotes[0]!.timestamp = later;
  observation.quotes[0]!.observedAt = later;
  expect(() => observePaperLedger(ledger, observation, later)).toThrow('PAPER_TRADING_DAY_REVIEW_REQUIRED');
});
