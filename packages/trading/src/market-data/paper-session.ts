import type { InstrumentId, PaperEvidence } from '@hth/contracts';
import { instantSchema } from '@hth/contracts';
import { marketDataPolicy, marketDate, observationBlocker, validMarketDay } from './policy.js';

export function paperSessionState(
  entries: readonly PaperEvidence[],
  instruments: readonly InstrumentId[],
  asOf: string,
): 'open' | 'closed' {
  if (!instantSchema.safeParse(asOf).success) throw new Error('PAPER_SESSION_UNVERIFIED');
  let closed = false;
  for (const instrument of instruments) {
    const entry = entries.find(
      (item) =>
        item.quote.instrument.market === instrument.market && item.quote.instrument.symbol === instrument.symbol,
    );
    if (
      !entry ||
      observationBlocker(entry.marketData.calendarObservedAt, asOf, marketDataPolicy.calendarMaxAgeMs, 'CALENDAR_STALE')
    )
      throw new Error('PAPER_SESSION_UNVERIFIED');
    const calendar = entry.marketData.calendar;
    if (!calendar) throw new Error('PAPER_SESSION_UNVERIFIED');
    const days = [calendar.previousBusinessDay, calendar.today, calendar.nextBusinessDay];
    if (
      days.some((day) => day.market !== instrument.market) ||
      days[0]!.tradingDate >= days[1]!.tradingDate ||
      days[1]!.tradingDate >= days[2]!.tradingDate
    )
      throw new Error('PAPER_SESSION_UNVERIFIED');
    const day = days.find((item) => item.tradingDate === marketDate(Date.parse(asOf), instrument.market));
    if (!day || !validMarketDay(day)) throw new Error('PAPER_SESSION_UNVERIFIED');
    if (
      !day.sessions.some(
        (session) =>
          session.type === 'regular' &&
          Date.parse(asOf) >= Date.parse(session.startsAt) &&
          Date.parse(asOf) < Date.parse(session.endsAt),
      )
    )
      closed = true;
  }
  return closed ? 'closed' : 'open';
}
