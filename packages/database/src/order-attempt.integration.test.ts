import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createDatabase } from './index.js';
import { createOrderAttemptTestStore } from './order-attempt.js';
import { orderAttemptAccounts as accounts, orderAttemptEvents as events } from './schema.js';
import { testDatabaseUrl, migrateTestDatabase } from '../test/setup.js';
import { orderAttemptFixture, attemptCommand } from '../test/order-attempt-fixtures.js';
import type { DurableOrderResult, OrderObservation } from '@hth/contracts';
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
async function fixture(f = orderAttemptFixture()) {
  const id = f.context.accountId;
  await store.initialize(f.context);
  await store.record(id, attemptCommand(await store.read(id), { kind: 'intent', intent: f.intent }));
  const opened = await store.record(id, attemptCommand(await store.read(id), { kind: 'open', ownerId: f.ownerId }));
  const claim = attemptCommand(opened.snapshot, {
    kind: 'attempt',
    intentId: f.intent.intentId,
    attemptId: f.attemptId,
    intentHash: opened.snapshot.state.intents[0]!.intentHash,
    ownerId: f.ownerId,
    epoch: opened.snapshot.state.epoch,
  });
  return { ...f, id, claim };
}
function ack(f: Awaited<ReturnType<typeof fixture>>): DurableOrderResult {
  return {
    mode: 'mock',
    executionEnabled: false,
    ownershipVerified: false,
    canApplyToLedger: false,
    canResend: false,
    replayed: false,
    clientOrderId: f.intent.request.clientOrderId,
    outcome: 'acknowledged',
    reference: `mock-${f.attemptId}`,
    status: 200,
  };
}
it.skipIf(!enabled)('의도와 내부 미적용 0 기준을 먼저 커밋하고 재초기화해도 보존한다', async () => {
  const f = await fixture(),
    before = await store.read(f.id);
  expect(before.state.intents[0]!.intent).toEqual(f.intent);
  expect(before.state.attempts).toHaveLength(0);
  expect(await store.initialize(f.context)).toEqual(before);
  await expect(store.initialize({ ...f.context, scopeHash: 'b'.repeat(64) })).rejects.toThrow(
    'ORDER_ATTEMPT_CONTEXT_CONFLICT',
  );
  expect((await store.read(f.id)).stateHash).toBe(before.stateHash);
});
it.skipIf(!enabled)('두 pool의 같은 claim 경합은 단 한 번만 새 시도를 반환한다', async () => {
  const f = await fixture();
  const receipts = await Promise.all([store.record(f.id, f.claim), other.record(f.id, f.claim)]);
  expect(receipts.map((r) => r.mockDispatchClaimed).sort()).toEqual([false, true]);
  expect(receipts.map((r) => r.replayed).sort()).toEqual([false, true]);
  const snapshot = await other.read(f.id);
  expect(snapshot).toMatchObject({ version: 3, executionEnabled: false, canResend: false, canApplyToLedger: false });
  expect(snapshot.state.attempts).toHaveLength(1);
  expect(snapshot.state.attempts[0]!.result).toBeNull();
});
it.skipIf(!enabled)('서로 다른 claim 경합은 낡은 CAS를 거부한다', async () => {
  const f = await fixture();
  const results = await Promise.allSettled([
    store.record(f.id, f.claim),
    other.record(f.id, { ...f.claim, operationId: randomUUID(), data: { ...f.claim.data, attemptId: randomUUID() } }),
  ]);
  expect(results.filter((v) => v.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((v) => v.status === 'rejected').map((v) => String(v.reason))).toEqual([
    'Error: ORDER_ATTEMPT_STALE',
  ]);
});
it.skipIf(!enabled)('재접속/같은 요청 replay는 원래 기록만 반환하고 새 dispatch를 허용하지 않는다', async () => {
  const f = await fixture(),
    first = await store.record(f.id, f.claim);
  const replay = await other.record(f.id, f.claim);
  expect(replay.event).toEqual(first.event);
  expect(replay).toMatchObject({ replayed: true, mockDispatchClaimed: false });
  await expect(
    other.record(f.id, {
      ...f.claim,
      operationId: randomUUID(),
      expectedVersion: 3,
      expectedStateHash: replay.snapshot.stateHash,
    }),
  ).rejects.toThrow('ORDER_ATTEMPT_ALREADY_CLAIMED');
  await expect(other.record(f.id, { ...f.claim, data: { ...f.claim.data, ownerId: randomUUID() } })).rejects.toThrow(
    'ORDER_ATTEMPT_OPERATION_CONFLICT',
  );
});
it.skipIf(!enabled)('전송 뒤 정지해도 원래 접수 응답은 보존하며 이전 소유자의 새 claim은 차단한다', async () => {
  const f = await fixture();
  await store.record(f.id, f.claim);
  await store.record(f.id, attemptCommand(await store.read(f.id), { kind: 'pause' }));
  const result = attemptCommand(await store.read(f.id), { kind: 'result', attemptId: f.attemptId, result: ack(f) });
  const saved = await store.record(f.id, result);
  expect(saved.snapshot.state.paused).toBe(true);
  expect(saved.snapshot.state.attempts[0]!.result?.outcome).toBe('acknowledged');
  expect((await other.record(f.id, result)).replayed).toBe(true);
  await expect(
    store.record(f.id, attemptCommand(saved.snapshot, { kind: 'result', attemptId: f.attemptId, result: ack(f) })),
  ).rejects.toThrow('ORDER_ATTEMPT_RESULT_CONFLICT');
  await expect(
    store.record(
      f.id,
      attemptCommand(saved.snapshot, {
        ...f.claim.data,
        kind: 'attempt',
        intentId: f.intent.intentId,
        attemptId: randomUUID(),
        intentHash: saved.snapshot.state.intents[0]!.intentHash,
        ownerId: f.ownerId,
        epoch: 1,
      }),
    ),
  ).rejects.toThrow('ORDER_ATTEMPT_FENCED');
});
it.skipIf(!enabled)('응답 유실은 null로 보존하고 UNKNOWN으로 덮거나 다음 client key로 우회하지 않는다', async () => {
  const f = await fixture();
  await store.record(f.id, f.claim);
  const later = orderAttemptFixture();
  await store.record(f.id, attemptCommand(await store.read(f.id), { kind: 'intent', intent: later.intent }));
  const snapshot = await other.read(f.id);
  expect(snapshot.state.attempts[0]!.result).toBeNull();
  await expect(
    store.record(
      f.id,
      attemptCommand(snapshot, {
        kind: 'attempt',
        intentId: later.intent.intentId,
        attemptId: later.attemptId,
        intentHash: snapshot.state.intents[1]!.intentHash,
        ownerId: f.ownerId,
        epoch: 1,
      }),
    ),
  ).rejects.toThrow('ORDER_ATTEMPT_REVIEW_REQUIRED');
});
it.skipIf(!enabled)('글로벌 client key와 의도 ID를 다른 계좌로 이전하지 못한다', async () => {
  const f = await fixture(),
    g = orderAttemptFixture();
  await store.initialize(g.context);
  const original = await store.read(g.context.accountId);
  for (const intent of [
    { ...g.intent, intentId: f.intent.intentId },
    { ...g.intent, request: { ...g.intent.request, clientOrderId: f.intent.request.clientOrderId } },
  ]) {
    await expect(
      store.record(g.context.accountId, attemptCommand(original, { kind: 'intent', intent })),
    ).rejects.toThrow('ORDER_ATTEMPT_DATABASE_FAILED');
    expect((await store.read(g.context.accountId)).version).toBe(0);
  }
});
it.skipIf(!enabled)('같은 신호에 새 의도/key를 만들거나 원본 요청을 바꾸지 못한다', async () => {
  const f = await fixture(),
    snapshot = await store.read(f.id),
    g = orderAttemptFixture();
  await expect(
    store.record(
      f.id,
      attemptCommand(snapshot, { kind: 'intent', intent: { ...g.intent, signalId: f.intent.signalId } }),
    ),
  ).rejects.toThrow('ORDER_ATTEMPT_INTENT_CONFLICT');
  expect((await store.read(f.id)).stateHash).toBe(snapshot.stateHash);
});
it.skipIf(!enabled)('이력 수정/삭제와 계좌 초기값 변경을 SQL에서도 막는다', async () => {
  const f = await fixture();
  await expect(
    db.db
      .update(events)
      .set({ eventHash: 'b'.repeat(64) })
      .where(eq(events.accountId, f.id)),
  ).rejects.toThrow();
  await expect(db.db.delete(events).where(eq(events.accountId, f.id))).rejects.toThrow();
  await expect(
    db.db
      .update(accounts)
      .set({ contextHash: 'b'.repeat(64), version: 3 })
      .where(eq(accounts.accountId, f.id)),
  ).rejects.toThrow();
  expect((await store.read(f.id)).version).toBe(2);
});
it.skipIf(!enabled)('aggregate 저장 실패는 시도/영구 key까지 전부 rollback한다', async () => {
  const f = await fixture(),
    name = `attempt_fail_${randomUUID().replaceAll('-', '')}`;
  await db.db.execute(
    sql.raw(
      `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.account_id='${f.id}'::uuid AND NEW.version=3 THEN RAISE EXCEPTION 'FIXTURE_FAILURE'; END IF; RETURN NEW; END; $$`,
    ),
  );
  await db.db.execute(
    sql.raw(`CREATE TRIGGER ${name} BEFORE UPDATE ON order_attempt_accounts FOR EACH ROW EXECUTE FUNCTION ${name}()`),
  );
  try {
    await expect(store.record(f.id, f.claim)).rejects.toThrow('ORDER_ATTEMPT_DATABASE_FAILED');
  } finally {
    await db.db.execute(sql.raw(`DROP TRIGGER ${name} ON order_attempt_accounts`));
    await db.db.execute(sql.raw(`DROP FUNCTION ${name}()`));
  }
  expect((await store.read(f.id)).version).toBe(2);
  expect(await db.db.select().from(events).where(eq(events.accountId, f.id))).toHaveLength(2);
  expect((await store.record(f.id, f.claim)).mockDispatchClaimed).toBe(true);
});
it.skipIf(!enabled)('이력과 head/version의 불일치는 복원/초기화하지 않고 차단한다', async () => {
  const f = await fixture();
  await db.db
    .update(accounts)
    .set({ version: 3, headHash: 'b'.repeat(64) })
    .where(eq(accounts.accountId, f.id));
  await expect(store.read(f.id)).rejects.toThrow('ORDER_ATTEMPT_INTEGRITY_FAILED');
  await expect(store.initialize(f.context)).rejects.toThrow('ORDER_ATTEMPT_INTEGRITY_FAILED');
});

async function fillFixture(prepared?: Awaited<ReturnType<typeof fixture>>) {
  const f = prepared ?? (await fixture());
  const claimed = await store.record(f.id, f.claim);
  const result = ack(f);
  if (result.outcome !== 'acknowledged') throw new Error('FIXTURE_ACK_REQUIRED');
  const saved = await store.record(
    f.id,
    attemptCommand(claimed.snapshot, { kind: 'result', attemptId: f.attemptId, result }),
  );
  const observation: OrderObservation = {
    formatVersion: 'order-observation-v1',
    scope: f.context.scopeHash,
    observedAt: saved.event.at,
    orderReference: result.reference,
    instrument: f.intent.request.instrument,
    side: 'BUY',
    currency: 'KRW',
    definition: { type: 'limit', validity: 'day', quantity: '5', limitPrice: '70000', orderedAt: claimed.event.at },
    state: 'partial',
    execution: {
      quantity: '2',
      amount: '140000',
      averagePrice: '70000',
      commission: '7',
      tax: '0',
      lastFilledAt: claimed.event.at,
      settlementDate: null,
    },
  };
  return { ...f, observation, snapshot: saved.snapshot };
}
it.skipIf(!enabled)('첫 부분 체결을 내부 0에서 기장하고 누적 전량 체결은 증가분만 반영한다', async () => {
  const f = await fillFixture();
  let current = await store.record(
    f.id,
    attemptCommand(f.snapshot, { kind: 'observe-fill', attemptId: f.attemptId, observation: f.observation }),
  );
  expect(current.snapshot.state.attempts[0]!.fills?.appliedTotals).toEqual(f.intent.internalOpening);
  const apply = attemptCommand(current.snapshot, {
    kind: 'apply-fill',
    attemptId: f.attemptId,
    observationSequence: 1,
  });
  const receipts = await Promise.all([store.record(f.id, apply), other.record(f.id, apply)]);
  expect(receipts.map((item) => item.replayed).sort()).toEqual([false, true]);
  expect(receipts[0]!.snapshot.state.attempts[0]!.fills?.applications).toEqual([
    {
      observationSequence: 1,
      delta: { quantity: '2', amount: '140000', commission: '7', tax: '0' },
      cashEffect: '-140007',
    },
  ]);
  const latest = await other.read(f.id);
  const endAt = latest.journal.at(-1)!.at;
  const filled: OrderObservation = {
    ...f.observation,
    observedAt: endAt,
    state: 'filled',
    execution: { ...f.observation.execution, quantity: '5', amount: '350000', commission: '18', lastFilledAt: endAt },
  };
  current = await other.record(
    f.id,
    attemptCommand(latest, { kind: 'observe-fill', attemptId: f.attemptId, observation: filled }),
  );
  current = await store.record(
    f.id,
    attemptCommand(current.snapshot, { kind: 'apply-fill', attemptId: f.attemptId, observationSequence: 2 }),
  );
  expect(current.snapshot.state.attempts[0]!.fills?.applications.at(-1)).toEqual({
    observationSequence: 2,
    delta: { quantity: '3', amount: '210000', commission: '11', tax: '0' },
    cashEffect: '-210011',
  });
  expect(current.snapshot).toMatchObject({ executionEnabled: false, canApplyToLedger: false, canResend: false });
  await expect(other.record(f.id, attemptCommand(current.snapshot, { ...apply.data }))).rejects.toThrow(
    'ORDER_ATTEMPT_FILL_SEQUENCE',
  );
});
it.skipIf(!enabled)('null 비용과 미적용 구간을 보존하고 이후 완전한 자료로 건너뛰지 않는다', async () => {
  const f = await fillFixture();
  const observation = { ...f.observation, execution: { ...f.observation.execution, tax: null } };
  const first = await store.record(
    f.id,
    attemptCommand(f.snapshot, { kind: 'observe-fill', attemptId: f.attemptId, observation }),
  );
  await expect(
    other.record(
      f.id,
      attemptCommand(first.snapshot, { kind: 'apply-fill', attemptId: f.attemptId, observationSequence: 1 }),
    ),
  ).rejects.toThrow('ORDER_ATTEMPT_FILL_REVIEW_REQUIRED');
  const next = await store.record(
    f.id,
    attemptCommand(first.snapshot, {
      kind: 'observe-fill',
      attemptId: f.attemptId,
      observation: { ...f.observation, observedAt: first.event.at },
    }),
  );
  await expect(
    other.record(
      f.id,
      attemptCommand(next.snapshot, { kind: 'apply-fill', attemptId: f.attemptId, observationSequence: 2 }),
    ),
  ).rejects.toThrow('ORDER_ATTEMPT_FILL_SEQUENCE');
  expect((await other.read(f.id)).state.attempts[0]!.fills).toMatchObject({
    appliedCount: 0,
    appliedTotals: f.intent.internalOpening,
    applications: [],
    observations: [{ observation, review: 'TOTALS_UNKNOWN' }, expect.any(Object)],
  });
});
it.skipIf(!enabled)('원래 접수와 다른 범위·주문 참조·요청 가격은 저장하지 않는다', async () => {
  const f = await fillFixture();
  for (const observation of [
    { ...f.observation, scope: 'b'.repeat(64) },
    { ...f.observation, orderReference: 'different-mock-order' },
    { ...f.observation, definition: { ...f.observation.definition, limitPrice: '60000' } },
  ]) {
    await expect(
      store.record(f.id, attemptCommand(f.snapshot, { kind: 'observe-fill', attemptId: f.attemptId, observation })),
    ).rejects.toThrow('ORDER_ATTEMPT_FILL_MISMATCH');
  }
  expect((await other.read(f.id)).version).toBe(f.snapshot.version);
});
it.skipIf(!enabled)('지정가를 넘는 매수 관측은 보존하되 기장하지 않는다', async () => {
  const f = await fillFixture();
  const observation = { ...f.observation, execution: { ...f.observation.execution, amount: '140001' } };
  const observed = await store.record(
    f.id,
    attemptCommand(f.snapshot, { kind: 'observe-fill', attemptId: f.attemptId, observation }),
  );
  await expect(
    other.record(
      f.id,
      attemptCommand(observed.snapshot, { kind: 'apply-fill', attemptId: f.attemptId, observationSequence: 1 }),
    ),
  ).rejects.toThrow('ORDER_ATTEMPT_FILL_REVIEW_REQUIRED');
  expect((await other.read(f.id)).state.attempts[0]!.fills?.observations[0]!.observation).toEqual(observation);
});

async function resourceFixture(side: 'BUY' | 'SELL' = 'BUY', ownQuantity = '0') {
  const input = orderAttemptFixture();
  input.context.source = 'mock-resource-v1';
  input.intent.request.side = side;
  const f = await fixture(input);
  const current = await store.read(f.id);
  const paused = await store.record(f.id, attemptCommand(current, { kind: 'pause' }));
  const instrument = f.intent.request.instrument;
  const cash = { KRW: '400000', USD: '80' };
  const opening = await store.record(
    f.id,
    attemptCommand(paused.snapshot, {
      kind: 'resource-opening',
      opening: {
        cash,
        manual: [{ instrument, quantity: '10' }],
        managed: [
          { instrument, strategyId: f.intent.strategyId, quantity: ownQuantity },
          { instrument, strategyId: randomUUID(), quantity: '4' },
        ],
      },
    }),
  );
  const observedAt = opening.event.at;
  const observation = {
    scopeHash: f.context.scopeHash,
    observedAt,
    cash,
    holdings: [{ instrument, quantity: String(14 + Number(ownQuantity)) }],
  };
  const observed = await store.record(
    f.id,
    attemptCommand(opening.snapshot, { kind: 'resource-observe', observation }),
  );
  const active = await store.record(f.id, attemptCommand(observed.snapshot, { kind: 'open', ownerId: f.ownerId }));
  if (f.claim.data.kind !== 'attempt') throw new Error('FIXTURE_CLAIM_REQUIRED');
  return {
    ...f,
    observation,
    opened: active.snapshot,
    claim: attemptCommand(active.snapshot, { ...f.claim.data, epoch: active.snapshot.state.epoch }),
  };
}
it.skipIf(!enabled)('현금 예약 뒤에만 시도를 만들고 첫 매수 기장을 자원과 원자적으로 반영한다', async () => {
  const f = await resourceFixture();
  await expect(store.record(f.id, f.claim)).rejects.toThrow('ORDER_ATTEMPT_RESOURCE_UNAVAILABLE');
  const reserve = attemptCommand(f.opened, {
    kind: 'resource-reserve',
    intentId: f.intent.intentId,
    cashBudget: '350020',
  });
  const held = await store.record(f.id, reserve);
  expect((await other.record(f.id, reserve)).replayed).toBe(true);
  expect(held.snapshot.state.resources?.reservation).toMatchObject({ cashRemaining: '350020', quantityRemaining: '5' });
  const fill = await fillFixture({ ...f, claim: attemptCommand(held.snapshot, f.claim.data) });
  const observation = { ...fill.observation };
  const observed = await store.record(
    f.id,
    attemptCommand(fill.snapshot, { kind: 'observe-fill', attemptId: f.attemptId, observation }),
  );
  const applied = await other.record(
    f.id,
    attemptCommand(observed.snapshot, { kind: 'apply-fill', attemptId: f.attemptId, observationSequence: 1 }),
  );
  expect(applied.snapshot.state.resources).toMatchObject({
    balances: {
      cash: { KRW: '259993', USD: '80' },
      manual: [{ quantity: '10' }],
      managed: [{ quantity: '2' }, { quantity: '4' }],
    },
    reservation: { cashRemaining: '210013', quantityRemaining: '3' },
    reconciliation: { differences: ['BALANCES_CHANGED'] },
  });
});
it.skipIf(!enabled)('예약 후 불일치가 들어오면 시도를 막고 내부 잔액을 덮어쓰지 않는다', async () => {
  const f = await resourceFixture();
  const held = await store.record(
    f.id,
    attemptCommand(f.opened, { kind: 'resource-reserve', intentId: f.intent.intentId, cashBudget: '350020' }),
  );
  const mismatch = await store.record(
    f.id,
    attemptCommand(held.snapshot, {
      kind: 'resource-observe',
      observation: { ...f.observation, observedAt: held.event.at, cash: { ...f.observation.cash, KRW: '400001' } },
    }),
  );
  await expect(other.record(f.id, attemptCommand(mismatch.snapshot, f.claim.data))).rejects.toThrow(
    'ORDER_ATTEMPT_RESOURCE_UNRECONCILED',
  );
  expect((await other.read(f.id)).state.resources).toMatchObject({
    balances: { cash: { KRW: '400000' } },
    reconciliation: { differences: ['KRW'] },
    reservation: { quantityRemaining: '5' },
  });
});
it.skipIf(!enabled)('수동 및 다른 전략의 보유분으로 매도 예약을 만들 수 없다', async () => {
  const f = await resourceFixture('SELL', '2');
  await expect(
    store.record(
      f.id,
      attemptCommand(f.opened, { kind: 'resource-reserve', intentId: f.intent.intentId, cashBudget: null }),
    ),
  ).rejects.toThrow('ORDER_ATTEMPT_RESOURCE_UNAVAILABLE');
  expect((await other.read(f.id)).state.resources?.reservation).toBeNull();
});
it.skipIf(!enabled)('부분 매도는 같은 전략 수량만 차감하고 매도대금은 미정산 금액으로 보존한다', async () => {
  const f = await resourceFixture('SELL', '5');
  const held = await store.record(
    f.id,
    attemptCommand(f.opened, { kind: 'resource-reserve', intentId: f.intent.intentId, cashBudget: null }),
  );
  const fill = await fillFixture({ ...f, claim: attemptCommand(held.snapshot, f.claim.data) });
  const observation = { ...fill.observation, side: 'SELL' as const };
  const observed = await store.record(
    f.id,
    attemptCommand(fill.snapshot, { kind: 'observe-fill', attemptId: f.attemptId, observation }),
  );
  const applied = await other.record(
    f.id,
    attemptCommand(observed.snapshot, { kind: 'apply-fill', attemptId: f.attemptId, observationSequence: 1 }),
  );
  expect(applied.snapshot.state.resources).toMatchObject({
    balances: {
      cash: { KRW: '400000', USD: '80' },
      manual: [{ quantity: '10' }],
      managed: [{ quantity: '3' }, { quantity: '4' }],
    },
    receivables: { KRW: '139993', USD: '0' },
    reservation: { quantityRemaining: '3' },
  });
});
it.skipIf(!enabled)('비용으로 예약이 부족하면 체결 관측만 남기고 기장 및 보유분 변경을 되돌린다', async () => {
  const f = await resourceFixture();
  const held = await store.record(
    f.id,
    attemptCommand(f.opened, { kind: 'resource-reserve', intentId: f.intent.intentId, cashBudget: '350000' }),
  );
  const fill = await fillFixture({ ...f, claim: attemptCommand(held.snapshot, f.claim.data) });
  const observed = await store.record(
    f.id,
    attemptCommand(fill.snapshot, { kind: 'observe-fill', attemptId: f.attemptId, observation: fill.observation }),
  );
  await expect(
    other.record(
      f.id,
      attemptCommand(observed.snapshot, { kind: 'apply-fill', attemptId: f.attemptId, observationSequence: 1 }),
    ),
  ).rejects.toThrow('ORDER_ATTEMPT_RESOURCE_UNAVAILABLE');
  const after = await other.read(f.id);
  expect(after.stateHash).toBe(observed.snapshot.stateHash);
  expect(after.state.attempts[0]!.fills).toMatchObject({ appliedCount: 0, observations: [expect.any(Object)] });
  expect(after.state.resources?.reservation).toEqual(held.snapshot.state.resources?.reservation);
});
