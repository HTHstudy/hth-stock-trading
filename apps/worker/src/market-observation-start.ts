import { setTimeout as delay } from 'node:timers/promises';
import type { Market, MarketCalendar } from '@hth/contracts';

// Waiting never acquires a DB connection or broker token. A sleeping computer
// must not silently turn a missed regular-session check into an off-hours run.
export async function waitForObservationStart(
  startsAt: string,
  signal: AbortSignal,
  now: () => number = Date.now,
  wait: (ms: number, signal: AbortSignal) => Promise<void> = (ms, stop) => delay(ms, undefined, { signal: stop }),
) {
  const target = Date.parse(startsAt);
  if (!Number.isFinite(target) || target - now() > 36 * 60 * 60_000)
    throw new Error('MARKET_OBSERVATION_CONFIGURATION_INVALID');
  while (now() < target) {
    signal.throwIfAborted();
    await wait(Math.min(30_000, target - now()), signal);
  }
  signal.throwIfAborted();
  if (now() - target > 120_000) throw new Error('OBSERVATION_START_MISSED');
}

export function requireObservationSession(
  calendar: MarketCalendar,
  market: Market,
  settings: { samples: number; intervalMs: number; timeoutMs: number },
  now: number,
) {
  const day = calendar.today;
  const budget = settings.samples * settings.timeoutMs + (settings.samples - 1) * settings.intervalMs;
  if (
    day.market !== market ||
    !day.sessionsKnown ||
    !day.sessions.some(
      (session) =>
        session.type === 'regular' && Date.parse(session.startsAt) <= now && now + budget < Date.parse(session.endsAt),
    )
  )
    throw new Error('OBSERVATION_SESSION_UNAVAILABLE');
}
