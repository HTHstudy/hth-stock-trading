import { expect, it, vi } from 'vitest';
import type { Candle, HistoricalRequest } from '@hth/contracts';
import type { ReadonlyBroker } from '@hth/broker';
import { collectHistoricalDataset } from './historical-collect.js';

const request: HistoricalRequest = {
  instrument: { market: 'KR', symbol: '005930' },
  interval: '1d',
  adjusted: false,
  from: '2026-03-25',
  to: '2026-03-25',
  source: 'toss',
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
const now = () => Date.parse('2026-03-27T00:00:00Z');
function fixture() {
  const broker = {
    id: 'toss',
    listAccounts: vi.fn(),
    getHoldings: vi.fn(),
    getBuyingPower: vi.fn(),
    getQuotes: vi.fn(),
    getExchangeRate: vi.fn(),
    getInstruments: vi.fn<ReadonlyBroker['getInstruments']>().mockResolvedValue([
      {
        id: request.instrument,
        name: 'Samsung',
        currency: 'KRW',
        exchange: 'KRX',
        status: 'NORMAL',
        krxTradingSuspended: false,
        nxtTradingSuspended: false,
        nxtSupported: true,
      },
    ]),
    getMarketCalendar: vi.fn<ReadonlyBroker['getMarketCalendar']>().mockImplementation(async (market, date) => ({
      today: {
        market,
        tradingDate: date!,
        sessionsKnown: true,
        sessions: [{ type: 'regular', startsAt: `${date}T09:00:00+09:00`, endsAt: `${date}T15:30:00+09:00` }],
      },
      previousBusinessDay: { market, tradingDate: '2026-03-24', sessionsKnown: true, sessions: [] },
      nextBusinessDay: { market, tradingDate: '2026-03-26', sessionsKnown: true, sessions: [] },
    })),
    getCandles: vi.fn<ReadonlyBroker['getCandles']>().mockResolvedValue({ candles: [candle], nextBefore: null }),
  } satisfies ReadonlyBroker;
  return broker;
}

it('요청 날짜의 캘린더와 시세만 읽고 계좌 기능을 호출하지 않는다', async () => {
  const broker = fixture();
  const dataset = await collectHistoricalDataset(broker, request, { now });
  expect(dataset.coverage.complete).toBe(true);
  expect(broker.getMarketCalendar).toHaveBeenCalledWith('KR', request.from);
  for (const method of [
    broker.listAccounts,
    broker.getHoldings,
    broker.getBuyingPower,
    broker.getQuotes,
    broker.getExchangeRate,
  ])
    expect(method).not.toHaveBeenCalled();
});
it('inclusive 경계의 중복 봉은 합치고 관측 이력은 보존한다', async () => {
  const broker = fixture();
  broker.getCandles
    .mockResolvedValueOnce({ candles: [candle], nextBefore: candle.timestamp })
    .mockResolvedValueOnce({ candles: [{ ...candle, close: '115' }], nextBefore: null });
  const dataset = await collectHistoricalDataset(broker, request, { now });
  expect(dataset.observations).toHaveLength(2);
  expect(dataset.candles).toHaveLength(1);
  expect(dataset.candles[0]?.close).toBe('115');
});
it('페이지 상한·진행하지 않는 커서·다른 캘린더를 거부한다', async () => {
  const broker = fixture();
  broker.getCandles.mockResolvedValue({ candles: [candle], nextBefore: candle.timestamp });
  await expect(collectHistoricalDataset(broker, request, { now, maxPages: 1 })).rejects.toThrow('BACKFILL_PAGE_LIMIT');
  await expect(collectHistoricalDataset(broker, request, { now })).rejects.toThrow('CANDLE_CURSOR_NOT_ADVANCING');
  const holiday = { market: 'KR' as const, tradingDate: '2026-03-24', sessionsKnown: true, sessions: [] };
  broker.getMarketCalendar.mockResolvedValue({
    today: holiday,
    previousBusinessDay: holiday,
    nextBusinessDay: holiday,
  });
  await expect(collectHistoricalDataset(broker, request, { now })).rejects.toThrow('CALENDAR_DATE_MISMATCH');
});
it('취소와 미래 요청은 네트워크 호출 전에 중단한다', async () => {
  const broker = fixture();
  await expect(collectHistoricalDataset(broker, request, { now, signal: AbortSignal.abort() })).rejects.toThrow(
    'CANCELLED',
  );
  await expect(collectHistoricalDataset(broker, { ...request, to: '2026-03-28' }, { now })).rejects.toThrow(
    'FUTURE_HISTORICAL_RANGE',
  );
  expect(broker.getInstruments).not.toHaveBeenCalled();
});
