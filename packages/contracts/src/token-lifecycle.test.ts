import { expect, it } from 'vitest';
import { tokenLifecycleSnapshotSchema, tokenLifecycleEventSchema } from './token-lifecycle.js';

function snapshot() {
  return {
    formatVersion: 'toss-token-lifecycle-v1',
    capturedAt: '2026-11-03T01:00:01Z',
    clockUnverified: false,
    counters: {
      initial: { started: 1, succeeded: 1, failed: 0, cancelled: 0 },
      expiry: { started: 0, succeeded: 0, failed: 0, cancelled: 0 },
      unauthorized: { started: 0, succeeded: 0, failed: 0, cancelled: 0 },
    },
    inFlight: 0,
    limited: false,
    events: [
      { attempt: 1, trigger: 'initial', phase: 'started', at: '2026-11-03T01:00:00Z' },
      {
        attempt: 1,
        trigger: 'initial',
        phase: 'succeeded',
        at: '2026-11-03T01:00:01Z',
        expiresInSeconds: 3600,
        validityBaseAt: '2026-11-03T01:00:00Z',
        refreshAt: '2026-11-03T01:59:00Z',
        expiresAt: '2026-11-03T02:00:00Z',
      },
    ],
  };
}
it('인증 데이터와 임의 오류 코드를 계약에서 거부한다', () => {
  expect(tokenLifecycleSnapshotSchema.safeParse(snapshot()).success).toBe(true);
  for (const key of ['access_token', 'clientId', 'clientSecret', 'accountId', 'requestId', 'raw', 'path'])
    expect(tokenLifecycleSnapshotSchema.safeParse({ ...snapshot(), [key]: 'PRIVATE' }).success).toBe(false);
  expect(
    tokenLifecycleEventSchema.safeParse({
      attempt: 1,
      trigger: 'initial',
      phase: 'failed',
      at: '2026-11-03T01:00:00Z',
      code: 'PRIVATE_ERROR',
    }).success,
  ).toBe(false);
});
it('순서·집계·진행 중 횟수·생략 표기·TTL 메타데이터의 모순을 거부한다', () => {
  for (const change of [
    { ...snapshot(), events: [] },
    { ...snapshot(), events: snapshot().events.toReversed() },
    { ...snapshot(), inFlight: 1 },
    { ...snapshot(), limited: true },
    { ...snapshot(), events: [snapshot().events[0], { ...snapshot().events[1], trigger: 'expiry' }] },
    { ...snapshot(), events: [snapshot().events[0], { ...snapshot().events[1], expiresInSeconds: 7200 }] },
    { ...snapshot(), capturedAt: '2026-11-03T00:00:00Z' },
  ])
    expect(tokenLifecycleSnapshotSchema.safeParse(change).success).toBe(false);
  expect(
    tokenLifecycleSnapshotSchema.safeParse({ ...snapshot(), capturedAt: '2026-11-03T00:00:00Z', clockUnverified: true })
      .success,
  ).toBe(true);
});
