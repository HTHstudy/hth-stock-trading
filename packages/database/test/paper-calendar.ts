import type { Market, MarketDay } from '@hth/contracts';

// Synthetic fixtures deliberately cover the current instant, not exchange hours.
export function syntheticPaperDay(now: Date, market: Market, tradingDate: string): MarketDay {
  const previousDate = new Date(Date.parse(`${tradingDate}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const offsetAt = (value: string) =>
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      timeZoneName: 'longOffset',
    })
      .formatToParts(new Date(`${value}T12:00:00Z`))
      .find((part) => part.type === 'timeZoneName')!
      .value.replace('GMT', '');
  let start = Date.parse(
    market === 'KR' ? `${tradingDate}T00:00:00+09:00` : `${previousDate}T20:00:00${offsetAt(previousDate)}`,
  );
  let end = Date.parse(
    market === 'KR' ? `${tradingDate}T23:59:59.999+09:00` : `${tradingDate}T19:59:59.999${offsetAt(tradingDate)}`,
  );
  // The fall-back day has 25 wall-clock hours. Keep the fixture below the
  // production session-duration bound while retaining the current minute.
  if (end - start >= 86_400_000) {
    if (now.getTime() >= end - 3_600_000) start += 3_600_000;
    else end -= 3_600_000;
  }
  return {
    market,
    tradingDate,
    sessionsKnown: true,
    sessions: [{ type: 'regular', startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString() }],
  };
}
