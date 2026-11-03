import { expect, it, vi } from 'vitest';
import { tokenLifecycleSnapshotSchema } from '@hth/contracts';
import { createTossReadonlyBroker } from './index.js';
import type { TossFetch } from './index.js';
import { jsonResponse, fixtures } from '../../test/harness.js';

function harness(handler?: TossFetch, signal?: AbortSignal, timeoutMs = 5000) {
  let time = Date.parse('2026-11-03T01:00:00Z'),
    issued = 0;
  const fetcher = vi.fn<TossFetch>(
    handler ??
      (async (url) =>
        url.endsWith('/oauth2/token')
          ? jsonResponse({ access_token: `PRIVATE_TOKEN_${++issued}`, token_type: 'Bearer', expires_in: 3600 })
          : jsonResponse(fixtures.accounts)),
  );
  const broker = createTossReadonlyBroker({
    clientId: 'PRIVATE_CLIENT',
    clientSecret: 'PRIVATE_SECRET',
    fetch: fetcher,
    now: () => time,
    wait: async (ms) => {
      time += ms;
    },
    random: () => 0,
    ...(signal ? { signal } : {}),
    timeoutMs,
  });
  return {
    broker,
    fetcher,
    advance: (ms: number) => {
      time += ms;
    },
    authCalls: () => fetcher.mock.calls.filter(([url]) => url.endsWith('/oauth2/token')).length,
  };
}
it('조회가 토큰을 발급하지 않고 snapshot 복사본에 비밀정보나 원본 응답을 포함하지 않는다', async () => {
  const { broker, fetcher } = harness();
  expect(broker.readTokenLifecycle().events).toEqual([]);
  expect(fetcher).not.toHaveBeenCalled();
  await broker.listAccounts();
  const snapshot = broker.readTokenLifecycle();
  expect(tokenLifecycleSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  expect(snapshot.counters.initial).toEqual({ started: 1, succeeded: 1, failed: 0, cancelled: 0 });
  expect(JSON.stringify(snapshot)).not.toMatch(
    /PRIVATE_|Authorization|Bearer|accountSeq|accountNo|requestId|https:|clientSecret/,
  );
  snapshot.events.splice(0);
  snapshot.counters.initial.succeeded = 999;
  expect(broker.readTokenLifecycle().events).toHaveLength(2);
  expect(broker.readTokenLifecycle().counters.initial.succeeded).toBe(1);
});
it('동시 요청은 실제 발급 시도 한 건으로 집계하고 유효 토큰 재사용은 세지 않는다', async () => {
  const { broker, authCalls } = harness();
  await Promise.all([broker.listAccounts(), broker.listAccounts(), broker.listAccounts()]);
  expect(authCalls()).toBe(1);
  expect(broker.readTokenLifecycle().events.map((e) => e.phase)).toEqual(['started', 'succeeded']);
  expect(broker.readTokenLifecycle().inFlight).toBe(0);
});
it('TTL의 갱신 시각을 지난 새 발급을 expiry로 구분하고 TTL을 고정하지 않는다', async () => {
  const { broker, advance } = harness();
  await broker.listAccounts();
  advance(3550000);
  await broker.listAccounts();
  const snapshot = broker.readTokenLifecycle();
  expect(snapshot.counters.expiry.succeeded).toBe(1);
  expect(snapshot.events.at(-1)).toMatchObject({
    attempt: 2,
    trigger: 'expiry',
    phase: 'succeeded',
    expiresInSeconds: 3600,
    refreshAt: '2026-11-03T02:58:10.000Z',
  });
  expect(snapshot.clockUnverified).toBe(false);
});
it('401 후 토큰 발급과 계속되는 계좌 조회 인증 거부를 서로 구분한다', async () => {
  let auth = 0;
  const { broker } = harness(async (url) =>
    url.endsWith('/oauth2/token')
      ? jsonResponse({ access_token: `TOKEN_${++auth}`, token_type: 'Bearer', expires_in: 3600 })
      : jsonResponse({ private: 'PRIVATE_RESPONSE' }, 401),
  );
  await expect(broker.listAccounts()).rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' });
  const snapshot = broker.readTokenLifecycle();
  expect(snapshot.counters.unauthorized).toEqual({ started: 1, succeeded: 1, failed: 0, cancelled: 0 });
  expect(snapshot.counters.initial.succeeded).toBe(1);
  expect(snapshot.counters.expiry.started).toBe(0);
});
it('발급 실패를 성공으로 세지 않고 다음 시도에도 원인을 유지하며 오류 원문을 제거한다', async () => {
  let auth = 0;
  const { broker } = harness(async (url) => {
    if (url.endsWith('/oauth2/token')) {
      if (++auth === 1) throw new Error('PRIVATE_ERROR_WITH_SECRET');
      return jsonResponse({ access_token: 'PRIVATE_TOKEN', token_type: 'Bearer', expires_in: 120 });
    }
    return jsonResponse(fixtures.accounts);
  });
  await expect(broker.listAccounts()).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  await broker.listAccounts();
  const snapshot = broker.readTokenLifecycle();
  expect(snapshot.counters.initial).toEqual({ started: 2, succeeded: 1, failed: 1, cancelled: 0 });
  expect(snapshot.events[1]).toMatchObject({ phase: 'failed', code: 'NETWORK_ERROR' });
  expect(JSON.stringify(snapshot)).not.toContain('PRIVATE');
});
it('유효기간 갱신이 실패해도 후속 갱신을 최초 발급으로 바꾸지 않는다', async () => {
  const { broker, fetcher, advance } = harness();
  await broker.listAccounts();
  advance(3550000);
  fetcher.mockImplementationOnce(async () => jsonResponse({ error: 'PRIVATE' }, 403));
  await expect(broker.listAccounts()).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  await broker.listAccounts();
  expect(broker.readTokenLifecycle().counters.expiry).toEqual({ started: 2, succeeded: 1, failed: 1, cancelled: 0 });
});
it('늦게 도착한 이전 토큰의 401은 새 토큰을 버리거나 발급 횟수를 늘리지 않는다', async () => {
  let auth = 0,
    oldRequests = 0;
  let release = () => {},
    entered = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const { broker } = harness(async (url, init) => {
    if (url.endsWith('/oauth2/token'))
      return jsonResponse({ access_token: `TOKEN_${++auth}`, token_type: 'Bearer', expires_in: 3600 });
    if (new Headers(init.headers).get('Authorization') === 'Bearer TOKEN_1') {
      if (++oldRequests === 2) {
        entered();
        await gate;
      }
      return jsonResponse({}, 401);
    }
    return jsonResponse(fixtures.accounts);
  });
  const first = broker.listAccounts(),
    second = broker.listAccounts();
  await waiting;
  await first;
  release();
  await second;
  expect(auth).toBe(2);
  expect(broker.readTokenLifecycle().counters.unauthorized.succeeded).toBe(1);
});
it('시작 전 취소는 시도로 세지 않고 발급 도중 취소는 실패와 분리한다', async () => {
  const pre = new AbortController();
  pre.abort();
  const unused = harness(undefined, pre.signal);
  await expect(unused.broker.listAccounts()).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(unused.broker.readTokenLifecycle().events).toHaveLength(0);
  const controller = new AbortController();
  let entered = () => {};
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const { broker } = harness(async (_url, init) => {
    entered();
    return new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(new Error('PRIVATE_ABORT')), { once: true });
    });
  }, controller.signal);
  const pending = broker.listAccounts();
  await waiting;
  expect(tokenLifecycleSnapshotSchema.parse(broker.readTokenLifecycle()).inFlight).toBe(1);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(broker.readTokenLifecycle().counters.initial).toEqual({ started: 1, succeeded: 0, failed: 0, cancelled: 1 });
});
it('취소를 무시한 늦은 인증 성공도 유효 토큰 성공 기록으로 남기지 않는다', async () => {
  const controller = new AbortController();
  const { broker } = harness(async () => {
    controller.abort();
    return jsonResponse({ access_token: 'PRIVATE_LATE', token_type: 'Bearer', expires_in: 3600 });
  }, controller.signal);
  await expect(broker.listAccounts()).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(broker.readTokenLifecycle().counters.initial.cancelled).toBe(1);
  expect(broker.readTokenLifecycle().counters.initial.succeeded).toBe(0);
});
it('인증 timeout은 한 번의 실패로 집계하고 실제 오류·요청 ID를 포함하지 않는다', async () => {
  const { broker, authCalls } = harness(
    async (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(new Error('PRIVATE_TIMEOUT')), { once: true });
      }),
    undefined,
    10,
  );
  await expect(broker.listAccounts()).rejects.toMatchObject({ code: 'TIMEOUT' });
  expect(authCalls()).toBe(1);
  expect(broker.readTokenLifecycle().events.at(-1)).toMatchObject({ phase: 'failed', code: 'TIMEOUT' });
});
it('상세 이력은 128건으로 제한하지만 전체 집계를 보존하고 시각 역행을 숨기지 않는다', async () => {
  const { broker, advance } = harness();
  for (let i = 0; i < 70; i++) {
    await broker.listAccounts();
    advance(3600000);
  }
  const snapshot = broker.readTokenLifecycle();
  expect(tokenLifecycleSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  expect(snapshot.events).toHaveLength(128);
  expect(snapshot.limited).toBe(true);
  expect(snapshot.counters.initial.succeeded).toBe(1);
  expect(snapshot.counters.expiry.succeeded).toBe(69);
  advance(-864000000);
  expect(broker.readTokenLifecycle().clockUnverified).toBe(true);
});

it.each([1, 120, 3600])('응답 TTL %i초의 정확한 갱신 경계와 보수적 시각을 기록한다', async (ttl) => {
  let time = Date.parse('2026-11-03T01:00:00Z');
  let auth = 0;
  const broker = createTossReadonlyBroker({
    clientId: 'fixture',
    clientSecret: 'fixture',
    now: () => time,
    wait: async (ms) => {
      time += ms;
    },
    fetch: async (url) =>
      url.endsWith('/oauth2/token')
        ? jsonResponse({ access_token: `TOKEN_${++auth}`, token_type: 'Bearer', expires_in: ttl })
        : jsonResponse(fixtures.accounts),
  });
  await broker.listAccounts();
  time += ttl * 1000 - Math.min(60000, ttl * 100);
  await Promise.all([broker.listAccounts(), broker.listAccounts()]);
  const snapshot = tokenLifecycleSnapshotSchema.parse(broker.readTokenLifecycle());
  expect(auth).toBe(2);
  expect(snapshot.counters.expiry.succeeded).toBe(1);
  const success = snapshot.events.at(-1);
  expect(success).toMatchObject({ phase: 'succeeded', expiresInSeconds: ttl });
});
it('동시에 기다린 요청 여러 개의 인증 실패를 발급 실패 한 건으로 센다', async () => {
  const { broker, authCalls } = harness(async () => jsonResponse({ error: 'PRIVATE' }, 403));
  const results = await Promise.allSettled([broker.listAccounts(), broker.listAccounts(), broker.listAccounts()]);
  expect(results.every((result) => result.status === 'rejected')).toBe(true);
  expect(authCalls()).toBe(1);
  expect(tokenLifecycleSnapshotSchema.parse(broker.readTokenLifecycle()).counters.initial.failed).toBe(1);
});
