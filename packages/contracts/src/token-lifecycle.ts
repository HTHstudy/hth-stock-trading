import { z } from 'zod';

export const tokenLifecycleTriggerSchema = z.enum(['initial', 'expiry', 'unauthorized']);
const timestamp = z.iso.datetime({ offset: true }).nullable();
const common = {
  attempt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  trigger: tokenLifecycleTriggerSchema,
  at: timestamp,
};
export const tokenLifecycleEventSchema = z.discriminatedUnion('phase', [
  z.object({ ...common, phase: z.literal('started') }).strict(),
  z
    .object({
      ...common,
      phase: z.literal('succeeded'),
      expiresInSeconds: z.number().int().positive().max(31536000),
      validityBaseAt: timestamp,
      refreshAt: timestamp,
      expiresAt: timestamp,
    })
    .strict(),
  z
    .object({
      ...common,
      phase: z.literal('failed'),
      code: z.enum([
        'INVALID_RESPONSE',
        'AUTHENTICATION_FAILED',
        'PERMISSION_DENIED',
        'RATE_LIMITED',
        'UPSTREAM_REJECTED',
        'UPSTREAM_UNAVAILABLE',
        'NETWORK_ERROR',
        'TIMEOUT',
        'UNKNOWN',
      ]),
    })
    .strict(),
  z.object({ ...common, phase: z.literal('cancelled'), code: z.literal('CANCELLED') }).strict(),
]);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const counters = z.object({ started: count, succeeded: count, failed: count, cancelled: count }).strict();
const tokenLifecycleSnapshotBaseSchema = z
  .object({
    formatVersion: z.literal('toss-token-lifecycle-v1'),
    capturedAt: timestamp,
    clockUnverified: z.boolean(),
    counters: z.object({ initial: counters, expiry: counters, unauthorized: counters }).strict(),
    inFlight: count.max(1),
    limited: z.boolean(),
    events: z.array(tokenLifecycleEventSchema).max(128),
  })
  .strict()
  .refine((value) => Object.values(value.counters).every((c) => c.started >= c.succeeded + c.failed + c.cancelled))
  .refine(
    (value) =>
      Object.values(value.counters).reduce((sum, c) => sum + c.started - c.succeeded - c.failed - c.cancelled, 0) ===
      value.inFlight,
  );
export const tokenLifecycleSnapshotSchema = tokenLifecycleSnapshotBaseSchema.refine(consistentEvents);
export type TokenLifecycleTrigger = z.infer<typeof tokenLifecycleTriggerSchema>;
export type TokenLifecycleEvent = z.infer<typeof tokenLifecycleEventSchema>;
export type TokenLifecycleSnapshot = z.infer<typeof tokenLifecycleSnapshotSchema>;

export const observationTokenLifecycleSchema = z
  .object({
    formatVersion: z.literal('observation-token-lifecycle-v1'),
    runId: z.uuid(),
    source: z.literal('toss-readonly'),
    manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
    snapshot: tokenLifecycleSnapshotSchema,
    hash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

function consistentEvents(value: z.infer<typeof tokenLifecycleSnapshotBaseSchema>) {
  const totals = {
    initial: { started: 0, succeeded: 0, failed: 0, cancelled: 0 },
    expiry: { started: 0, succeeded: 0, failed: 0, cancelled: 0 },
    unauthorized: { started: 0, succeeded: 0, failed: 0, cancelled: 0 },
  };
  let previous: TokenLifecycleEvent | undefined;
  for (const event of value.events) {
    totals[event.trigger][event.phase]++;
    if (!previous) {
      if (!value.limited && (event.attempt !== 1 || event.phase !== 'started')) return false;
    } else if (previous.phase === 'started') {
      if (event.phase === 'started' || event.attempt !== previous.attempt || event.trigger !== previous.trigger)
        return false;
    } else if (event.phase !== 'started' || event.attempt !== previous.attempt + 1) return false;
    previous = event;
  }
  const attempts = Object.values(value.counters).reduce((sum, c) => sum + c.started, 0);
  if (value.limited && value.events.length !== 128) return false;
  if ((previous?.attempt ?? 0) !== attempts || (previous?.phase === 'started' ? 1 : 0) !== value.inFlight) return false;
  for (const trigger of tokenLifecycleTriggerSchema.options)
    for (const phase of ['started', 'succeeded', 'failed', 'cancelled'] as const) {
      if (
        value.limited
          ? totals[trigger][phase] > value.counters[trigger][phase]
          : totals[trigger][phase] !== value.counters[trigger][phase]
      )
        return false;
    }
  if (!value.clockUnverified) {
    let last = -Infinity;
    for (const event of value.events) {
      if (event.at === null || Date.parse(event.at) < last) return false;
      last = Date.parse(event.at);
      if (event.phase === 'succeeded') {
        if (event.validityBaseAt === null || event.refreshAt === null || event.expiresAt === null) return false;
        const base = Date.parse(event.validityBaseAt),
          ttl = event.expiresInSeconds * 1000;
        if (
          Date.parse(event.expiresAt) !== base + ttl ||
          Date.parse(event.refreshAt) !== base + ttl - Math.min(60000, ttl * 0.1) ||
          Date.parse(event.at) < base ||
          Date.parse(event.at) >= Date.parse(event.refreshAt)
        )
          return false;
      }
    }
    if (value.capturedAt === null || Date.parse(value.capturedAt) < last) return false;
  }
  return true;
}
