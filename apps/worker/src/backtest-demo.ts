import type { Candle, HistoricalCalendarObservation, HistoricalObservation } from '@hth/contracts';
import { buildHistoricalDataset } from '@hth/trading';

export function createBacktestDemo() {
  const instrument = { market: 'KR', symbol: 'DEMO' } as const;
  const observedAt = '2026-04-01T00:00:00Z';
  const prices = [100, 99, 97, 95, 96, 99, 103, 108, 112, 110, 105, 99, 94, 90, 92, 96, 102, 109, 115, 111, 106, 100];
  const calendars: HistoricalCalendarObservation[] = [];
  const observations: HistoricalObservation[] = [];
  let index = 0;
  for (let at = Date.parse('2026-03-02T00:00:00Z'); index < prices.length; at += 86_400_000) {
    const date = new Date(at);
    const tradingDate = date.toISOString().slice(0, 10);
    const holiday = date.getUTCDay() === 0 || date.getUTCDay() === 6;
    calendars.push({
      day: {
        market: 'KR',
        tradingDate,
        sessionsKnown: true,
        sessions: holiday
          ? []
          : [{ type: 'regular', startsAt: `${tradingDate}T09:00:00+09:00`, endsAt: `${tradingDate}T15:30:00+09:00` }],
      },
      observedAt,
    });
    if (holiday) continue;
    const open = String(prices[Math.max(0, index - 1)]!);
    const close = String(prices[index]!);
    const candle: Candle = {
      instrument,
      interval: '1d',
      timestamp: `${tradingDate}T00:00:00+09:00`,
      tradingDate,
      open,
      close,
      high: String(Math.max(Number(open), Number(close))),
      low: String(Math.min(Number(open), Number(close))),
      volume: '1000',
      currency: 'KRW',
      adjusted: false,
      source: 'synthetic-demo-v1',
      isClosed: false,
    };
    observations.push({ candle, observedAt, page: 1 });
    index += 1;
  }
  return buildHistoricalDataset({
    request: {
      instrument,
      interval: '1d',
      adjusted: false,
      from: calendars[0]!.day.tradingDate,
      to: calendars.at(-1)!.day.tradingDate,
      source: 'synthetic-demo-v1',
    },
    instrument: { name: 'Synthetic example, not market data', currency: 'KRW', nxtSupportedAtCollection: null },
    calendars,
    observations,
    startedAt: observedAt,
    completedAt: observedAt,
  });
}
