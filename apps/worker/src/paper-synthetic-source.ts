import type { PaperEvidence } from '@hth/contracts';
import { marketTradingDate } from '@hth/trading';
import type { PaperSource } from './paper-worker.js';

export const paperSyntheticSource: PaperSource = async (instruments, signal) => {
  signal.throwIfAborted();
  const now = new Date();
  const observedAt = now.toISOString();
  const date = marketTradingDate(now.getTime(), 'KR');
  const latest = Math.floor(now.getTime() / 60_000) * 60_000 - 60_000;
  const price = (timestamp: number) => ['1000', '900', '1100', '900'][Math.floor(timestamp / 60_000) % 4]!;
  const day = (offset: number) => {
    const tradingDate = new Date(Date.parse(`${date}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
    return {
      market: 'KR' as const,
      tradingDate,
      sessionsKnown: true,
      sessions: [
        {
          type: 'regular' as const,
          startsAt: `${tradingDate}T00:00:00+09:00`,
          endsAt: `${tradingDate}T23:59:59.999+09:00`,
        },
      ],
    };
  };
  return instruments.map((instrument): PaperEvidence => {
    if (instrument.market !== 'KR') throw new Error('PAPER_DEMO_KR_ONLY');
    return {
      sourcesHealthy: true,
      hasUnknownOrders: false,
      quote: { instrument, price: price(latest), timestamp: observedAt, observedAt },
      marketData: {
        nxtSupported: false,
        restricted: false,
        candles: Array.from({ length: 3 }, (_, index) => {
          const timestamp = latest - (2 - index) * 60_000;
          const close = price(timestamp);
          return {
            instrument,
            interval: '1m',
            timestamp: new Date(timestamp).toISOString(),
            tradingDate: marketTradingDate(timestamp - 1, 'KR'),
            open: close,
            high: close,
            low: close,
            close,
            volume: '10',
            currency: 'KRW',
            adjusted: false,
            source: 'synthetic-worker-v1',
            isClosed: false,
          };
        }),
        candlesObservedAt: observedAt,
        calendarObservedAt: observedAt,
        calendar: { today: day(0), previousBusinessDay: day(-1), nextBusinessDay: day(1) },
        exchangeRate: {
          validFrom: new Date(now.getTime() - 3600_000).toISOString(),
          validUntil: new Date(now.getTime() + 3600_000).toISOString(),
        },
      },
    };
  });
};
