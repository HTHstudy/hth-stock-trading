import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { createDatabase, contentHash } from '@hth/database';
import { createOrderAttemptTestStore, migrateTestDatabase, testDatabaseUrl } from '@hth/database/testing';
import { createTossOrderMockSession } from '@hth/broker/testing';
import { createTossOrderWriter } from '@hth/broker/toss';
import { collectMockOrderRecoveryDetail } from './order-attempt-recovery.js';
import { dispatchOrderAttemptMockOnce } from './order-attempt-mock.js';
import type { OrderAttemptEventData, DurableOrderIntent } from '@hth/contracts';
const enabled = Boolean(process.env.TEST_DATABASE_URL);
let db: ReturnType<typeof createDatabase>, otherDb: ReturnType<typeof createDatabase>;
let store: ReturnType<typeof createOrderAttemptTestStore>, other: typeof store;
beforeAll(async () => {
  if (!enabled) return;
  db = createDatabase(testDatabaseUrl());
  otherDb = createDatabase(testDatabaseUrl());
  await migrateTestDatabase(db);
  store = createOrderAttemptTestStore(db, testDatabaseUrl());
  other = createOrderAttemptTestStore(otherDb, testDatabaseUrl());
}, 30000);
afterAll(async () => {
  await Promise.all([db?.close(), otherDb?.close()]);
});
const command = (snapshot: { version: number; stateHash: string }, data: OrderAttemptEventData) => ({
  operationId: randomUUID(),
  expectedVersion: snapshot.version,
  expectedStateHash: snapshot.stateHash,
  data,
});
const json = (value: unknown) =>
  new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
async function fixture(withResources = false) {
  const accountId = randomUUID(),
    ownerId = randomUUID(),
    attemptId = randomUUID();
  const intent: DurableOrderIntent = {
    intentId: randomUUID(),
    strategyId: randomUUID(),
    signalId: randomUUID(),
    strategyRevision: 1,
    request: {
      profile: 'limit-day-integer-v1',
      clientOrderId: randomUUID(),
      instrument: { market: 'KR', symbol: '005930' },
      side: 'BUY',
      quantity: '5',
      limitPrice: '70000',
    },
    expiresAt: new Date(Date.now() + 600000).toISOString(),
    internalOpening: { quantity: '0', amount: '0', commission: '0', tax: '0' },
  };
  const scopeHash = 'a'.repeat(64);
  let snapshot = await store.initialize({
    source: withResources ? 'mock-resource-v1' : 'mock-wire-v1',
    brokerId: 'toss',
    accountId,
    scopeHash,
  });
  const cash = { KRW: '400000', USD: '0' };
  if (withResources) {
    const opening = await store.record(
      accountId,
      command(snapshot, { kind: 'resource-opening', opening: { cash, manual: [], managed: [] } }),
    );
    snapshot = (
      await store.record(
        accountId,
        command(opening.snapshot, {
          kind: 'resource-observe',
          observation: { scopeHash, observedAt: opening.event.at, cash, holdings: [] },
        }),
      )
    ).snapshot;
  }
  snapshot = (await store.record(accountId, command(snapshot, { kind: 'intent', intent }))).snapshot;
  if (withResources)
    snapshot = (
      await store.record(
        accountId,
        command(snapshot, { kind: 'resource-reserve', intentId: intent.intentId, cashBudget: '351000' }),
      )
    ).snapshot;
  const opened = await store.record(accountId, command(await store.read(accountId), { kind: 'open', ownerId }));
  const claim = command(opened.snapshot, {
    kind: 'attempt',
    intentId: intent.intentId,
    attemptId,
    intentHash: contentHash(intent),
    ownerId,
    epoch: opened.snapshot.state.epoch,
  });
  const respond = vi.fn(async () =>
    json({ result: { orderId: `mock-${attemptId}`, clientOrderId: intent.request.clientOrderId } }),
  );
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    expect(new URL(url).origin).toBe('https://toss-writer.invalid');
    if (new URL(url).pathname === '/oauth2/token')
      return json({ access_token: 'fake-token', token_type: 'Bearer', expires_in: 3600 });
    expect(init.method).toBe('POST');
    expect(new URL(url).pathname).toBe('/api/v1/orders');
    // A separate connection can see the committed attempt before the fake transport runs.
    expect((await other.read(accountId)).state.attempts[0]).toMatchObject({ attemptId, result: null });
    return respond();
  });
  const makeSession = () =>
    createTossOrderMockSession({ clientId: 'fake-client', clientSecret: 'fake-secret', fetch: fetcher });
  const options = { store, session: makeSession(), accountId, claim, resultOperationId: randomUUID() };
  return { options, respond, fetcher, makeSession, accountId, intent, attemptId };
}
it.skipIf(!enabled)('의도/시도 커밋 뒤 가짜 전송하고 접수만 보존한다', async () => {
  const f = await fixture(),
    result = await dispatchOrderAttemptMockOnce(f.options);
  expect(result.mockWriterInvoked).toBe(true);
  expect(result.snapshot.state.attempts[0]!.result).toMatchObject({ outcome: 'acknowledged', canApplyToLedger: false });
  expect(result.snapshot.state.intents[0]!.intent.internalOpening.quantity).toBe('0');
  expect(result.snapshot.version).toBe(4);
  expect(f.respond).toHaveBeenCalledTimes(1);
});
it.skipIf(!enabled)('다른 pool/새 token manager로 재시작해도 DB replay는 인증/POST를 시작하지 않는다', async () => {
  const f = await fixture();
  await dispatchOrderAttemptMockOnce(f.options);
  f.fetcher.mockClear();
  const replay = await dispatchOrderAttemptMockOnce({ ...f.options, store: other, session: f.makeSession() });
  expect(replay.mockWriterInvoked).toBe(false);
  expect(f.fetcher).not.toHaveBeenCalled();
  expect(replay.snapshot.state.attempts[0]!.result?.outcome).toBe('acknowledged');
});
it.skipIf(!enabled)('전송 직전 프로세스 중단에 해당하는 저장 시도는 후속 호출이 보내지 않는다', async () => {
  const f = await fixture();
  await store.record(f.accountId, f.options.claim);
  const restarted = await dispatchOrderAttemptMockOnce({ ...f.options, session: f.makeSession(), store: other });
  expect(restarted.mockWriterInvoked).toBe(false);
  expect(f.fetcher).not.toHaveBeenCalled();
  expect(restarted.snapshot.state.attempts[0]!.result).toBeNull();
});
it.skipIf(!enabled)('응답 유실의 UNKNOWN을 저장하고 재시작 뒤에도 한 번만 전송한다', async () => {
  const f = await fixture();
  f.respond.mockRejectedValueOnce(new Error('PRIVATE_NETWORK_ERROR'));
  const result = await dispatchOrderAttemptMockOnce(f.options);
  expect(result.snapshot.state.attempts[0]!.result).toMatchObject({ outcome: 'unknown', code: 'NETWORK_ERROR' });
  f.fetcher.mockClear();
  await dispatchOrderAttemptMockOnce({ ...f.options, session: f.makeSession() });
  expect(f.fetcher).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toContain('PRIVATE');
});
it.skipIf(!enabled)('접수 뒤 DB 저장 실패는 미확인으로 남고 재시작이 다시 보내지 않는다', async () => {
  const f = await fixture(),
    record = vi.fn<typeof store.record>(async (id, input) => {
      if ((input as { data?: { kind?: string } }).data?.kind === 'result')
        throw new Error('ORDER_ATTEMPT_DATABASE_FAILED');
      return store.record(id, input);
    });
  await expect(dispatchOrderAttemptMockOnce({ ...f.options, store: { ...store, record } })).rejects.toThrow(
    'ORDER_ATTEMPT_DATABASE_FAILED',
  );
  expect((await other.read(f.accountId)).state.attempts[0]!.result).toBeNull();
  f.fetcher.mockClear();
  await dispatchOrderAttemptMockOnce({ ...f.options, session: f.makeSession(), store: other });
  expect(f.fetcher).not.toHaveBeenCalled();
});
it.skipIf(!enabled)('claim 이후 전송 전 정지가 확인되면 가짜 통신도 시작하지 않는다', async () => {
  const f = await fixture(),
    read = vi.fn<typeof store.read>(async (id) => {
      const snapshot = await store.read(id);
      if (snapshot.state.attempts.length && !snapshot.state.paused) {
        await store.record(f.accountId, command(snapshot, { kind: 'pause' }));
        return store.read(id);
      }
      return snapshot;
    });
  await expect(dispatchOrderAttemptMockOnce({ ...f.options, store: { ...store, read } })).rejects.toThrow(
    'ORDER_ATTEMPT_FENCED',
  );
  expect(f.fetcher).not.toHaveBeenCalled();
  expect((await store.read(f.accountId)).state.paused).toBe(true);
});
it.skipIf(!enabled)('가짜 전송 중 정지는 원래 응답을 버리거나 자동 청산하지 않는다', async () => {
  const f = await fixture();
  f.respond.mockImplementationOnce(async () => {
    await store.record(f.accountId, command(await store.read(f.accountId), { kind: 'pause' }));
    return json({ result: { orderId: `mock-${f.attemptId}`, clientOrderId: f.intent.request.clientOrderId } });
  });
  const result = await dispatchOrderAttemptMockOnce(f.options);
  expect(result.snapshot.state.paused).toBe(true);
  expect(result.snapshot.state.attempts[0]!.result?.outcome).toBe('acknowledged');
  expect(f.respond).toHaveBeenCalledTimes(1);
});
it.skipIf(!enabled)('닫힌 운영 writer를 테스트 실행기로 바꿔 전달하지 못한다', async () => {
  const f = await fixture(),
    before = await store.read(f.accountId);
  await expect(
    dispatchOrderAttemptMockOnce({ ...f.options, session: { ...f.options.session, writer: createTossOrderWriter() } }),
  ).rejects.toThrow('ORDER_ATTEMPT_MOCK_REQUIRED');
  expect((await store.read(f.accountId)).stateHash).toBe(before.stateHash);
  expect(f.fetcher).not.toHaveBeenCalled();
});

it.skipIf(!enabled)('인증 실패는 writer 호출과 주문 POST 미진입을 구분해 저장한다', async () => {
  const f = await fixture();
  const fetcher = vi.fn(async (url: string) => {
    expect(new URL(url).origin).toBe('https://toss-writer.invalid');
    expect(new URL(url).pathname).toBe('/oauth2/token');
    return new Response('{}', { status: 403 });
  });
  const session = createTossOrderMockSession({ clientId: 'fake', clientSecret: 'fake', fetch: fetcher });
  const result = await dispatchOrderAttemptMockOnce({ ...f.options, session });
  expect(result.mockWriterInvoked).toBe(true);
  expect(result.snapshot.state.attempts[0]!.result).toMatchObject({ outcome: 'not-sent', code: 'PERMISSION_DENIED' });
  expect(fetcher).toHaveBeenCalledTimes(1);
  await dispatchOrderAttemptMockOnce({ ...f.options, session: f.makeSession() });
  expect(f.fetcher).not.toHaveBeenCalled();
});

it.skipIf(!enabled)('시도 커밋 뒤 확인한 자원 불일치는 가짜 인증과 주문 호출을 모두 막는다', async () => {
  const f = await fixture(true);
  const read = vi.fn<typeof store.read>(async (id) => {
    const snapshot = await store.read(id);
    const event = snapshot.journal.at(-1)!;
    expect(event.data.kind).toBe('attempt');
    const changed = await other.record(
      id,
      command(snapshot, {
        kind: 'resource-observe',
        observation: {
          scopeHash: snapshot.context.scopeHash,
          observedAt: event.at,
          cash: { KRW: '399000', USD: '0' },
          holdings: [],
        },
      }),
    );
    return changed.snapshot;
  });
  await expect(dispatchOrderAttemptMockOnce({ ...f.options, store: { ...store, read } })).rejects.toThrow(
    'ORDER_ATTEMPT_RESOURCE_UNRECONCILED',
  );
  expect(f.fetcher).not.toHaveBeenCalled();
  const snapshot = await other.read(f.accountId);
  expect(snapshot.state.attempts[0]!.result).toBeNull();
  expect(snapshot.state.resources?.reservation?.cashRemaining).toBe('351000');
});

async function recoveryFixture(acknowledged = true) {
  const f = await fixture(true);
  if (acknowledged) await dispatchOrderAttemptMockOnce(f.options);
  else await store.record(f.accountId, f.options.claim);
  const paused = await store.record(f.accountId, command(await store.read(f.accountId), { kind: 'pause' }));
  const input = {
    accountId: f.accountId,
    attemptId: f.attemptId,
    operationId: randomUUID(),
    expectedVersion: paused.snapshot.version,
    expectedStateHash: paused.snapshot.stateHash,
  };
  const reference = `mock-${f.attemptId}`;
  const orderedAt = paused.snapshot.state.attempts[0]!.claimedAt;
  const detail = {
    orderId: reference,
    symbol: '005930',
    side: 'BUY',
    orderType: 'LIMIT',
    timeInForce: 'DAY',
    status: 'PARTIAL_FILLED',
    price: '70000',
    quantity: '5',
    currency: 'KRW',
    orderedAt,
    execution: {
      filledQuantity: '2',
      averageFilledPrice: '70000',
      filledAmount: '140000',
      commission: '7',
      tax: '0',
      filledAt: orderedAt,
      settlementDate: null,
    },
  };
  const readDetail = vi.fn(async () => json({ result: detail }));
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    expect(new URL(url).origin).toBe('https://toss-writer.invalid');
    if (new URL(url).pathname === '/oauth2/token')
      return json({ access_token: 'fake-token', token_type: 'Bearer', expires_in: 3600 });
    expect(init.method).toBe('GET');
    expect(new URL(url).pathname).toBe(`/api/v1/orders/${reference}`);
    expect(new Headers(init.headers).get('x-tossinvest-account')).toBe('42');
    return readDetail();
  });
  const session = createTossOrderMockSession({ clientId: 'fake-client', clientSecret: 'fake-secret', fetch: fetcher });
  return { ...f, input, session, lookupFetch: fetcher, readDetail, detail, paused: paused.snapshot };
}
it.skipIf(!enabled)('저장된 접수 ID만 조회하고 증거를 재조회해도 통신과 기장은 반복하지 않는다', async () => {
  const f = await recoveryFixture();
  const found = await collectMockOrderRecoveryDetail(store, f.session, f.input);
  expect(found.event.data).toMatchObject({
    kind: 'recovery-detail',
    evidence: { outcome: 'observed', observation: { state: 'partial', execution: { quantity: '2' } } },
  });
  expect(found.snapshot.state).toEqual(f.paused.state);
  expect(found.mockDispatchClaimed).toBe(false);
  f.lookupFetch.mockClear();
  expect((await collectMockOrderRecoveryDetail(other, f.session, f.input)).replayed).toBe(true);
  expect(f.lookupFetch).not.toHaveBeenCalled();
  if (found.event.data.kind !== 'recovery-detail' || found.event.data.evidence.outcome !== 'observed')
    throw new Error('FIXTURE_EVIDENCE_REQUIRED');
  const observed = await store.record(
    f.accountId,
    command(found.snapshot, {
      kind: 'observe-fill',
      attemptId: f.attemptId,
      observation: found.event.data.evidence.observation,
    }),
  );
  const booked = await other.record(
    f.accountId,
    command(observed.snapshot, { kind: 'apply-fill', attemptId: f.attemptId, observationSequence: 1 }),
  );
  expect(booked.snapshot.state.resources?.balances.cash.KRW).toBe('259993');
});
it.skipIf(!enabled)('응답 유실 시 주문 ID를 추정 조회하지 않고 수동 사유만 보존한다', async () => {
  const f = await recoveryFixture(false);
  await expect(collectMockOrderRecoveryDetail(store, f.session, f.input)).rejects.toThrow(
    'ORDER_ATTEMPT_RECOVERY_BLOCKED',
  );
  expect(f.lookupFetch).not.toHaveBeenCalled();
  const review = await store.record(
    f.accountId,
    command(f.paused, { kind: 'recovery-review', attemptId: f.attemptId, reason: 'unverified-candidate' }),
  );
  expect(review.snapshot.state).toEqual(f.paused.state);
  expect(review.event.data).toEqual({
    kind: 'recovery-review',
    attemptId: f.attemptId,
    reason: 'unverified-candidate',
  });
  expect((await other.read(f.accountId)).state.resources?.reservation?.cashRemaining).toBe('351000');
  await expect(
    store.record(
      f.accountId,
      command(review.snapshot, { kind: 'resource-release', intentId: f.intent.intentId, reason: 'not-sent' }),
    ),
  ).rejects.toThrow('ORDER_ATTEMPT_RESOURCE_RELEASE_BLOCKED');
});
it.skipIf(!enabled).each(['http-404', 'invalid-response'] as const)(
  '상세 조회 실패 %s는 접수나 예약을 변경하지 않는다',
  async (outcome) => {
    const f = await recoveryFixture();
    f.readDetail.mockResolvedValueOnce(
      outcome === 'http-404'
        ? new Response('{}', { status: 404 })
        : json({ result: { ...f.detail, orderId: 'unrelated-order' } }),
    );
    const recorded = await collectMockOrderRecoveryDetail(store, f.session, f.input);
    expect(recorded.event.data).toMatchObject({ kind: 'recovery-detail', evidence: { outcome } });
    expect(recorded.snapshot.state).toEqual(f.paused.state);
  },
);
it.skipIf(!enabled)('조회 도중 계좌 제어가 바뀌면 낡은 증거를 저장하지 않는다', async () => {
  const f = await recoveryFixture();
  f.readDetail.mockImplementationOnce(async () => {
    await other.record(f.accountId, command(f.paused, { kind: 'open', ownerId: randomUUID() }));
    return json({ result: f.detail });
  });
  await expect(collectMockOrderRecoveryDetail(store, f.session, f.input)).rejects.toThrow('ORDER_ATTEMPT_STALE');
  expect((await other.read(f.accountId)).journal.some((event) => event.data.kind === 'recovery-detail')).toBe(false);
});
