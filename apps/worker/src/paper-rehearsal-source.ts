import type { Candle, InstrumentId, MarketDay, PaperEvidence } from '@hth/contracts';
import { assessCandle, marketTradingDate } from '@hth/trading';

// Independent synthetic frames with an optional fixed candle anchor. Quotes
// use fresh DB time; this is not continuous/point-in-time market replay.
export function rehearsalEvidence(
  instrument: InstrumentId,
  prices: readonly [string, string, string],
  asOf: string,
  candleAsOf = asOf,
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
    const next = new Date(Date.parse(`${tradingDate}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
    const from = Date.parse(
      market === 'KR' ? `${tradingDate}T00:00:00+09:00` : `${previous}T20:00:00${offsetAt(previous)}`,
    );
    const to = Date.parse(
      // Sessions use an exclusive end. The final candle's end timestamp may
      // equal it, so subtracting 1ms discards the boundary minute itself.
      market === 'KR' ? `${next}T00:00:00+09:00` : `${tradingDate}T20:00:00${offsetAt(tradingDate)}`,
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
  const candleTime = Date.parse(candleAsOf);
  if (!Number.isFinite(candleTime) || candleTime > now) throw new Error('PAPER_REHEARSAL_TIME_INVALID');
  const end = Math.floor(candleTime / 60000) * 60000 - 60000;
  const calendar = { today: day(0), previousBusinessDay: day(-1), nextBusinessDay: day(1) };
  const nxtSupported = market === 'KR' ? false : null;
  const candle = (timestamp: number, price: string): Candle => ({
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
  });
  // Choose eligible synthetic instants; keep returned flags unconfirmed so the
  // worker revalidates them. In particular, never bypass KR closing-bar waits.
  const timestamps = Array.from({ length: 4 }, (_, index) => end - (3 - index) * 60000)
    .filter((timestamp) => {
      const raw = candle(timestamp, '1');
      const day =
        [calendar.previousBusinessDay, calendar.today, calendar.nextBusinessDay].find(
          (d) => d.tradingDate === raw.tradingDate,
        ) ?? null;
      return assessCandle(raw, { asOf: candleAsOf, observedAt: candleAsOf, day, nxtSupported }).status === 'closed';
    })
    .slice(-3);
  if (timestamps.length !== 3) throw new Error('PAPER_REHEARSAL_CANDLES_UNAVAILABLE');
  return {
    sourcesHealthy: true,
    hasUnknownOrders: false,
    quote: { instrument, price: prices[2], timestamp: asOf, observedAt: asOf },
    marketData: {
      nxtSupported,
      restricted: false,
      candles: timestamps.map((timestamp, index) => candle(timestamp, prices[index]!)),
      candlesObservedAt: asOf,
      calendar,
      calendarObservedAt: asOf,
      exchangeRate: {
        validFrom: new Date(now - 3600000).toISOString(),
        validUntil: new Date(now + 3600000).toISOString(),
      },
    },
  };
}
