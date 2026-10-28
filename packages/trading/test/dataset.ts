import type { Candle, HistoricalCalendarObservation, HistoricalObservation } from '@hth/contracts';
import { buildHistoricalDataset } from '../src/market-data/historical.js';

export function testDataset(bars: readonly { open: number; close: number }[], minute = false) {
  const market = minute ? 'US' : 'KR';
  const instrument = { market, symbol: minute ? 'AAPL' : '005930' } as const;
  const observedAt = '2026-06-01T00:00:00Z';
  const dates: string[] = [];
  let date = Date.parse('2026-03-09T00:00:00Z');
  while (dates.length < bars.length) {
    const current = new Date(date);
    if (current.getUTCDay() !== 0 && current.getUTCDay() !== 6) dates.push(current.toISOString().slice(0, 10));
    date += 86_400_000;
  }
  const to = minute ? dates[0]! : dates.at(-1)!;
  const calendars: HistoricalCalendarObservation[] = [];
  for (let at = Date.parse(`${dates[0]}T00:00:00Z`); at <= Date.parse(`${to}T00:00:00Z`); at += 86_400_000) {
    const day = new Date(at);
    const tradingDate = day.toISOString().slice(0, 10);
    calendars.push({
      day: {
        market,
        tradingDate,
        sessionsKnown: true,
        sessions:
          day.getUTCDay() === 0 || day.getUTCDay() === 6
            ? []
            : [
                {
                  type: 'regular',
                  startsAt: minute ? `${tradingDate}T09:30:00-04:00` : `${tradingDate}T09:00:00+09:00`,
                  endsAt: minute
                    ? new Date(Date.parse(`${tradingDate}T09:30:00-04:00`) + bars.length * 60_000).toISOString()
                    : `${tradingDate}T15:30:00+09:00`,
                },
              ],
      },
      observedAt,
    });
  }
  const observations: HistoricalObservation[] = bars.map((bar, index) => {
    const tradingDate = minute ? dates[0]! : dates[index]!;
    const candle: Candle = {
      instrument,
      interval: minute ? '1m' : '1d',
      timestamp: minute
        ? new Date(Date.parse(`${tradingDate}T09:30:00-04:00`) + (index + 1) * 60_000).toISOString()
        : `${tradingDate}T00:00:00+09:00`,
      tradingDate,
      open: String(bar.open),
      close: String(bar.close),
      high: String(Math.max(bar.open, bar.close)),
      low: String(Math.min(bar.open, bar.close)),
      volume: '100',
      currency: minute ? 'USD' : 'KRW',
      adjusted: false,
      source: 'toss',
      isClosed: false,
    };
    return { candle, observedAt, page: 1 };
  });
  return buildHistoricalDataset({
    request: { instrument, interval: minute ? '1m' : '1d', adjusted: false, from: dates[0]!, to, source: 'toss' },
    instrument: { name: 'Test', currency: minute ? 'USD' : 'KRW', nxtSupportedAtCollection: null },
    calendars,
    observations,
    startedAt: observedAt,
    completedAt: observedAt,
  });
}
