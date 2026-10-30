import type { InstrumentId, MarketDay, PaperEvidence } from '@hth/contracts';
import { marketTradingDate } from '@hth/trading';

// Independent synthetic frames, rebased to fresh DB time. These are not a
// historical dataset or a claim of continuous/point-in-time market replay.
export function rehearsalEvidence(
  instrument: InstrumentId,
  prices: readonly [string, string, string],
  asOf: string,
): PaperEvidence {
  const now = Date.parse(asOf),
    market = instrument.market;
  const date = marketTradingDate(now, market);
  const offsetAt = (date: string) =>
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'longOffset' })
      .formatToParts(new Date(`${date}T12:00:00Z`))
      .find((part) => part.type === 'timeZoneName')!
      .value.replace('GMT', '');
  const day = (offset: number): MarketDay => {
    const tradingDate = new Date(Date.parse(`${date}T00:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
    const previous = new Date(Date.parse(`${tradingDate}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
    const from = Date.parse(
      market === 'KR' ? `${tradingDate}T00:00:00+09:00` : `${previous}T20:00:00${offsetAt(previous)}`,
    );
    const to = Date.parse(
      market === 'KR' ? `${tradingDate}T23:59:59.999+09:00` : `${tradingDate}T19:59:59.999${offsetAt(tradingDate)}`,
    );
    const anchor = Math.max(from, Math.min(now, to - 1));
    const endsAt = Math.min(to, anchor + 4 * 3600000);
    const startsAt = Math.max(from, endsAt - 8 * 3600000);
    return {
      market,
      tradingDate,
      sessionsKnown: true,
      sessions: [
        { type: 'regular', startsAt: new Date(startsAt).toISOString(), endsAt: new Date(endsAt).toISOString() },
      ],
    };
  };
  const end = Math.floor(now / 60000) * 60000 - 60000;
  return {
    sourcesHealthy: true,
    hasUnknownOrders: false,
    quote: { instrument, price: prices[2], timestamp: asOf, observedAt: asOf },
    marketData: {
      nxtSupported: market === 'KR' ? false : null,
      restricted: false,
      candles: prices.map((price, index) => {
        const timestamp = end - (2 - index) * 60000;
        return {
          instrument,
          interval: '1m',
          timestamp: new Date(timestamp).toISOString(),
          tradingDate: marketTradingDate(timestamp - 1, market),
          open: price,
          high: price,
          low: price,
          close: price,
          volume: '10',
          currency: market === 'KR' ? 'KRW' : 'USD',
          adjusted: false,
          source: 'synthetic-rehearsal-v1',
          isClosed: false,
        };
      }),
      candlesObservedAt: asOf,
      calendar: { today: day(0), previousBusinessDay: day(-1), nextBusinessDay: day(1) },
      calendarObservedAt: asOf,
      exchangeRate: {
        validFrom: new Date(now - 3600000).toISOString(),
        validUntil: new Date(now + 3600000).toISOString(),
      },
    },
  };
}
