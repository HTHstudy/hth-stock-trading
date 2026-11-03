import type { TokenLifecycleEvent, TokenLifecycleSnapshot, TokenLifecycleTrigger } from '@hth/contracts';

export function lifecycleTimestamp(milliseconds: number) {
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

// Transport-local and bounded. No subscriber, logging, I/O, credentials, or raw errors.
export function createTokenLifecycle(now: () => number) {
  const counters: TokenLifecycleSnapshot['counters'] = {
    initial: { started: 0, succeeded: 0, failed: 0, cancelled: 0 },
    expiry: { started: 0, succeeded: 0, failed: 0, cancelled: 0 },
    unauthorized: { started: 0, succeeded: 0, failed: 0, cancelled: 0 },
  };
  const events: TokenLifecycleEvent[] = [];
  let attempt = 0,
    inFlight = 0,
    limited = false,
    clockUnverified = false,
    lastAt: number | undefined;
  function record(event: TokenLifecycleEvent) {
    const at = event.at === null ? NaN : Date.parse(event.at);
    if (!Number.isFinite(at) || (lastAt !== undefined && at < lastAt)) clockUnverified = true;
    if (Number.isFinite(at)) lastAt = at;
    counters[event.trigger][event.phase]++;
    inFlight += event.phase === 'started' ? 1 : -1;
    if (events.length === 128) {
      events.shift();
      limited = true;
    }
    events.push(event);
  }
  return {
    start(trigger: TokenLifecycleTrigger) {
      const id = ++attempt;
      record({ attempt: id, trigger, phase: 'started', at: lifecycleTimestamp(now()) });
      return id;
    },
    record,
    read(): TokenLifecycleSnapshot {
      const at = now();
      return {
        formatVersion: 'toss-token-lifecycle-v1',
        capturedAt: lifecycleTimestamp(at),
        clockUnverified:
          clockUnverified || !Number.isFinite(new Date(at).getTime()) || (lastAt !== undefined && at < lastAt),
        counters: structuredClone(counters),
        inFlight,
        limited,
        events: structuredClone(events),
      };
    },
  };
}
