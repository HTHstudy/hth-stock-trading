import { expect, it } from 'vitest';
import { marketTradingDate } from '@hth/trading';
import { syntheticPaperDay } from './paper-calendar.js';

it('DST 전환일의 첫·마지막 시간에도 합성 세션은 24시간 미만이며 현재 시각을 포함한다', () => {
  for (const instant of [
    '2026-11-01T00:30:00Z',
    '2026-11-02T00:30:00Z',
    '2026-03-08T01:30:00Z',
    '2026-03-08T23:30:00Z',
  ]) {
    const now = new Date(instant);
    const date = marketTradingDate(now.getTime(), 'US');
    const day = syntheticPaperDay(now, 'US', date);
    const session = day.sessions[0]!;
    const start = Date.parse(session.startsAt),
      end = Date.parse(session.endsAt);
    expect(end - start).toBeLessThan(86_400_000);
    expect(start).toBeLessThanOrEqual(now.getTime());
    expect(end).toBeGreaterThan(now.getTime());
    expect(marketTradingDate(start, 'US')).toBe(date);
    expect(marketTradingDate(end - 1, 'US')).toBe(date);
  }
});
