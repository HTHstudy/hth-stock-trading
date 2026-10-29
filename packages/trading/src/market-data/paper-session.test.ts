import { expect, it } from 'vitest';
import type { PaperEvidence } from '@hth/contracts';
import { paperSessionState } from './paper-session.js';

function entry(
  date = '2026-03-25',
  market: 'KR' | 'US' = 'KR',
  offset = '+09:00',
  at = '2026-03-25T01:00:00Z',
): PaperEvidence {
  const instrument = { market, symbol: market === 'KR' ? '005930' : 'AAPL' };
  const day = (change: number) => {
    const tradingDate = new Date(Date.parse(`${date}T00:00:00Z`) + change * 86400000).toISOString().slice(0, 10);
    return {
      market,
      tradingDate,
      sessionsKnown: true,
      sessions: [
        {
          type: 'regular' as const,
          startsAt: `${tradingDate}T${market === 'KR' ? '09:00' : '09:30'}:00${offset}`,
          endsAt: `${tradingDate}T${market === 'KR' ? '15:30' : '16:00'}:00${offset}`,
        },
      ],
    };
  };
  return {
    quote: { instrument, price: '1', timestamp: null, observedAt: at },
    sourcesHealthy: true,
    hasUnknownOrders: false,
    marketData: {
      candles: [],
      candlesObservedAt: at,
      nxtSupported: false,
      restricted: false,
      calendarObservedAt: at,
      calendar: { previousBusinessDay: day(-1), today: day(0), nextBusinessDay: day(1) },
      exchangeRate: { validFrom: at, validUntil: at },
    },
  };
}
it('정규장 안/밖과 확인된 휴장을 구분하며 quote 시각을 새로 만들지 않는다', () => {
  const evidence = entry();
  expect(paperSessionState([evidence], [evidence.quote.instrument], evidence.quote.observedAt)).toBe('open');
  evidence.marketData.calendar!.today.sessions = [];
  expect(paperSessionState([evidence], [evidence.quote.instrument], evidence.quote.observedAt)).toBe('closed');
  expect(evidence.quote.timestamp).toBeNull();
});
it.each([
  ['2026-03-25', '-04:00', '2026-03-25T13:30:00Z'],
  ['2026-01-15', '-05:00', '2026-01-15T14:30:00Z'],
])('US 정규장 DST 경계를 따른다: %s', (date, offset, asOf) => {
  const evidence = entry(date, 'US', offset, asOf);
  expect(paperSessionState([evidence], [evidence.quote.instrument], asOf)).toBe('open');
  const end = evidence.marketData.calendar!.today.sessions[0]!.endsAt;
  evidence.marketData.calendarObservedAt = end;
  expect(paperSessionState([evidence], [evidence.quote.instrument], end)).toBe('closed');
});
it('미확인/만료/미래 캘린더를 휴장으로 간주하지 않는다', () => {
  for (const mutate of [
    (item: PaperEvidence) => {
      item.marketData.calendar!.today.sessionsKnown = false;
    },
    (item: PaperEvidence) => {
      item.marketData.calendarObservedAt = '2026-03-25T00:00:00Z';
    },
    (item: PaperEvidence) => {
      item.marketData.calendarObservedAt = '2026-03-25T01:01:00Z';
    },
    (item: PaperEvidence) => {
      item.marketData.calendar = null;
    },
  ]) {
    const evidence = entry();
    mutate(evidence);
    expect(() => paperSessionState([evidence], [evidence.quote.instrument], evidence.quote.observedAt)).toThrow(
      'PAPER_SESSION_UNVERIFIED',
    );
  }
});
