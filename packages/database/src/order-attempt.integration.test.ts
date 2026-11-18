import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createDatabase } from './index.js';
import { createOrderAttemptTestStore } from './order-attempt.js';
import { orderAttemptAccounts as accounts, orderAttemptEvents as events } from './schema.js';
import { testDatabaseUrl, migrateTestDatabase } from '../test/setup.js';
import { orderAttemptFixture, attemptCommand } from '../test/order-attempt-fixtures.js';
import type { DurableOrderResult } from '@hth/contracts';
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
async function fixture() {
  const f = orderAttemptFixture(),
    id = f.context.accountId;
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
