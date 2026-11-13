import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDatabase, contentHash } from './index.js';
import { createSyntheticOrderBindingStore } from './synthetic-order-binding.js';
import { createSyntheticOrderReviewStore } from './order-review.js';
import { reviewFixture } from '../test/order-review-fixtures.js';
import { accountFixture } from '../test/paper-fixtures.js';
import {
  paperAccounts,
  syntheticBindingAccounts as accounts,
  syntheticBindingIntents as intents,
  syntheticOrderBindings as bindings,
  syntheticBindingEvents as events,
} from './schema.js';
import { testDatabaseUrl, migrateTestDatabase } from '../test/setup.js';
import { syntheticBindingFixture, syntheticBindingEvidence } from '../test/synthetic-binding-fixtures.js';
import type { SyntheticOrderBindingInput } from '@hth/contracts';
const enabled = Boolean(process.env.TEST_DATABASE_URL);
let db: ReturnType<typeof createDatabase>, otherDb: ReturnType<typeof createDatabase>;
let store: ReturnType<typeof createSyntheticOrderBindingStore>, other: typeof store;
beforeAll(async () => {
  if (!enabled) return;
  db = createDatabase(testDatabaseUrl());
  otherDb = createDatabase(testDatabaseUrl());
  await migrateTestDatabase(db);
  store = createSyntheticOrderBindingStore(db, testDatabaseUrl());
  other = createSyntheticOrderBindingStore(otherDb, testDatabaseUrl());
}, 30000);
afterAll(async () => {
  await Promise.all([db?.close(), otherDb?.close()]);
});
const initialize = (input: SyntheticOrderBindingInput) => ({
  source: 'synthetic-fixture',
  namespace: input.context.namespace,
  scope: input.context.scope,
});
async function seed(input: SyntheticOrderBindingInput) {
  const before = await store.read(input.context.namespace.accountId);
  return store.recordIntent({
    source: 'synthetic-fixture',
    intent: input.intent,
    expectedVersion: before.version,
    expectedStateHash: before.stateHash,
  });
}
async function fixture() {
  const input = syntheticBindingFixture();
  await store.initialize(initialize(input));
  await seed(input);
  return input;
}
async function command(input: SyntheticOrderBindingInput) {
  const before = await store.read(input.context.namespace.accountId);
  return {
    source: 'synthetic-fixture',
    operationId: randomUUID(),
    expectedVersion: before.version,
    expectedStateHash: before.stateHash,
    evidence: syntheticBindingEvidence(input),
  };
}
const rows = (id: string) => db.db.select().from(events).where(eq(events.accountId, id));
it.skipIf(!enabled)('의도를 먼저 커밋하고 같은 계좌의 바인딩/처리 이력을 원자적으로 저장한다', async () => {
  const input = await fixture(),
    c = await command(input),
    id = input.context.namespace.accountId;
  const result = await store.record(c);
  expect(result.receipt).toMatchObject({
    outcome: 'bound',
    versionBefore: 1,
    versionAfter: 2,
    review: { outcome: 'consistent-synthetic-binding', bindingPersisted: false },
    ledgerApplied: false,
    ownershipVerified: false,
  });
  expect(await store.read(id)).toMatchObject({
    version: 2,
    intentCount: 1,
    bindingCount: 1,
    eventCount: 1,
    registry: { complete: true, bindings: [input.candidate] },
  });
  expect(await store.initialize(initialize(input))).toMatchObject({ version: 2, bindingCount: 1, eventCount: 1 });
});
it.skipIf(!enabled)('동일 의도 재조회는 초기화하지 않고 내용/신호 키 재사용은 거부한다', async () => {
  const input = await fixture(),
    before = await store.read(input.context.namespace.accountId);
  expect((await seed(input)).replayed).toBe(true);
  const changed = structuredClone(input);
  changed.intent!.strategy.revision++;
  await expect(seed(changed)).rejects.toThrow('ORDER_BINDING_INTENT_CONFLICT');
  const newId = structuredClone(input);
  newId.intent!.intentId = randomUUID();
  await expect(seed(newId)).rejects.toThrow('ORDER_BINDING_SIGNAL_EXISTS');
  expect((await store.read(input.context.namespace.accountId)).stateHash).toBe(before.stateHash);
});
it.skipIf(!enabled)('기대 버전/hash가 낡은 의도 등록은 기존 데이터를 바꾸지 않는다', async () => {
  const input = syntheticBindingFixture(),
    before = await store.initialize(initialize(input));
  await seed(input);
  const next = structuredClone(input.intent!);
  next.intentId = randomUUID();
  next.dedupeKey = contentHash(randomUUID());
  await expect(
    store.recordIntent({
      source: 'synthetic-fixture',
      intent: next,
      expectedVersion: before.version,
      expectedStateHash: before.stateHash,
    }),
  ).rejects.toThrow('ORDER_BINDING_VERSION_CONFLICT');
  expect((await store.read(input.context.namespace.accountId)).intentCount).toBe(1);
});
it.skipIf(!enabled)('같은 operation의 동시 요청은 한 번만 저장하고 다른 연결은 receipt를 재사용한다', async () => {
  const input = await fixture(),
    c = await command(input);
  const result = await Promise.all([store.record(c), other.record(c)]);
  expect(result.map((r) => r.replayed).sort()).toEqual([false, true]);
  expect(result[0]!.receipt).toEqual(result[1]!.receipt);
  expect(await rows(input.context.namespace.accountId)).toHaveLength(1);
});
it.skipIf(!enabled)('같은 operation ID의 요청 수정은 영구 거부하며 새 ID도 중복 연결을 못 만든다', async () => {
  const input = await fixture(),
    c = await command(input);
  await store.record(c);
  await expect(store.record({ ...c, expectedVersion: 2 })).rejects.toThrow('ORDER_BINDING_OPERATION_REUSED');
  const changed = structuredClone(input);
  changed.candidate!.bindingId = randomUUID();
  const result = await store.record(await command(changed));
  expect(result.receipt).toMatchObject({
    outcome: 'blocked',
    review: { reasons: expect.arrayContaining(['INTENT_ALREADY_BOUND', 'ORDER_ALREADY_BOUND']) },
  });
  expect((await store.read(input.context.namespace.accountId)).bindingCount).toBe(1);
});
it.skipIf(!enabled)('서로 다른 의도의 CAS 경합은 하나만 연결하고 충돌을 자동 재시도하지 않는다', async () => {
  const input = await fixture(),
    second = syntheticBindingFixture();
  const namespace = input.context.namespace;
  second.context = { ...input.context };
  second.observationNamespace = { ...namespace };
  second.observation.scope = input.context.scope;
  for (const record of [second.candidate!, second.intent!, second.attempt!, second.acknowledgement!])
    record.namespace = { ...namespace };
  await seed(second);
  const firstCommand = await command(input),
    secondCommand = await command(second);
  const result = await Promise.all([store.record(firstCommand), other.record(secondCommand)]);
  expect(result.map((r) => r.receipt.outcome).sort()).toEqual(['bound', 'conflict']);
  expect(await store.read(namespace.accountId)).toMatchObject({
    version: 3,
    intentCount: 2,
    bindingCount: 1,
    eventCount: 2,
  });
});
it.skipIf(!enabled)('다른 의도로 같은 주문을 연결해도 기존 원래 소유자를 바꾸지 않는다', async () => {
  const input = await fixture();
  await store.record(await command(input));
  const second = structuredClone(input);
  second.intent!.intentId = randomUUID();
  second.intent!.dedupeKey = contentHash(randomUUID());
  second.candidate!.intentId = second.intent!.intentId;
  second.candidate!.dedupeKey = second.intent!.dedupeKey;
  second.candidate!.bindingId = randomUUID();
  second.attempt!.intentId = second.intent!.intentId;
  second.acknowledgement!.intentId = second.intent!.intentId;
  await seed(second);
  expect((await store.record(await command(second))).receipt).toMatchObject({
    outcome: 'blocked',
    review: { reasons: expect.arrayContaining(['ORDER_ALREADY_BOUND']) },
  });
  expect((await store.read(input.context.namespace.accountId)).registry.bindings).toEqual([input.candidate]);
});
it.skipIf(!enabled)('DB에 선기록한 의도가 없으면 가짜 acceptance가 있어도 미배정으로 보존한다', async () => {
  const input = syntheticBindingFixture();
  await store.initialize(initialize(input));
  expect((await store.record(await command(input))).receipt.outcome).toBe('unassigned');
  expect(await store.read(input.context.namespace.accountId)).toMatchObject({
    version: 0,
    intentCount: 0,
    bindingCount: 0,
    eventCount: 1,
  });
});
it.skipIf(!enabled)('재접속 뒤 과거 receipt를 재조회하고 이후 unchanged 기록이 초기 증거를 바꾸지 않는다', async () => {
  const input = await fixture(),
    c = await command(input);
  const first = await store.record(c),
    reconnectDb = createDatabase(testDatabaseUrl());
  try {
    const reconnect = createSyntheticOrderBindingStore(reconnectDb, testDatabaseUrl());
    expect(await reconnect.record(c)).toEqual({ replayed: true, receipt: first.receipt });
    const initial = await db.db.select().from(bindings).where(eq(bindings.bindingId, input.candidate!.bindingId));
    const updated = structuredClone(input);
    updated.context.connectionGeneration++;
    expect((await reconnect.record(await command(updated))).receipt.outcome).toBe('unchanged');
    expect(await db.db.select().from(bindings).where(eq(bindings.bindingId, input.candidate!.bindingId))).toEqual(
      initial,
    );
    expect((await reconnect.record(c)).receipt.versionAfter).toBe(2);
    expect((await reconnect.read(input.context.namespace.accountId)).eventCount).toBe(2);
  } finally {
    await reconnectDb.close();
  }
});
it.skipIf(!enabled)('최종 계좌 갱신 실패는 새 바인딩과 event를 함께 rollback하고 원문을 숨긴다', async () => {
  const input = await fixture(),
    c = await command(input),
    before = await store.read(input.context.namespace.accountId);
  const original = db.db.transaction.bind(db.db),
    injected = vi.spyOn(db.db, 'transaction');
  injected.mockImplementationOnce((operation, config) =>
    original(async (tx) => {
      const update = vi.spyOn(tx, 'update').mockImplementation(() => {
        throw new Error('PRIVATE_STORAGE_DETAIL');
      });
      try {
        return await operation(tx);
      } finally {
        update.mockRestore();
      }
    }, config),
  );
  try {
    await expect(store.record(c)).rejects.toThrow('ORDER_BINDING_TRANSACTION_FAILED');
  } finally {
    injected.mockRestore();
  }
  expect((await store.read(input.context.namespace.accountId)).stateHash).toBe(before.stateHash);
  expect(
    await db.db.select().from(bindings).where(eq(bindings.accountId, input.context.namespace.accountId)),
  ).toHaveLength(0);
  expect(await rows(input.context.namespace.accountId)).toHaveLength(0);
  expect((await store.record(c)).receipt.outcome).toBe('bound');
});
it.skipIf(!enabled)('복합 FK는 다른 계좌 의도를 참조하는 직접 삽입도 거부한다', async () => {
  const input = await fixture(),
    otherInput = await fixture();
  await store.record(await command(input));
  const [bound] = await db.db.select().from(bindings).where(eq(bindings.bindingId, input.candidate!.bindingId));
  await expect(
    db.db
      .insert(bindings)
      .values({ ...bound!, bindingId: randomUUID(), accountId: otherInput.context.namespace.accountId }),
  ).rejects.toThrow();
  expect((await store.read(otherInput.context.namespace.accountId)).bindingCount).toBe(0);
});
it.skipIf(!enabled)('불변 의도/연결/event의 수정·삭제를 DB에서도 거부한다', async () => {
  const input = await fixture(),
    id = input.context.namespace.accountId;
  await store.record(await command(input));
  await expect(
    db.db
      .update(intents)
      .set({ payloadHash: '0'.repeat(64) })
      .where(eq(intents.accountId, id)),
  ).rejects.toThrow();
  await expect(db.db.delete(bindings).where(eq(bindings.accountId, id))).rejects.toThrow();
  await expect(
    db.db
      .update(events)
      .set({ receiptHash: '0'.repeat(64) })
      .where(eq(events.accountId, id)),
  ).rejects.toThrow();
  expect((await store.read(id)).bindingCount).toBe(1);
});
it.skipIf(!enabled)('계좌 상태 hash가 달라지면 조회/재초기화/새 기록을 모두 차단한다', async () => {
  const input = await fixture(),
    id = input.context.namespace.accountId,
    c = await command(input);
  await db.db
    .update(accounts)
    .set({ stateHash: '0'.repeat(64) })
    .where(eq(accounts.accountId, id));
  await expect(store.read(id)).rejects.toThrow('ORDER_BINDING_INTEGRITY_FAILED');
  await expect(store.initialize(initialize(input))).rejects.toThrow('ORDER_BINDING_INTEGRITY_FAILED');
  await expect(store.record(c)).rejects.toThrow('ORDER_BINDING_INTEGRITY_FAILED');
});
it.skipIf(!enabled)('새 계좌 UUID로 같은 scope를 재등록하거나 기존 계좌 출처를 바꿀 수 없다', async () => {
  const input = await fixture(),
    seed = initialize(input);
  await expect(
    store.initialize({ ...seed, namespace: { ...seed.namespace, accountId: randomUUID() } }),
  ).rejects.toThrow();
  await expect(
    store.initialize({ ...seed, namespace: { ...seed.namespace, brokerId: 'other-broker' } }),
  ).rejects.toThrow('ORDER_BINDING_ACCOUNT_CONFLICT');
  expect((await store.read(input.context.namespace.accountId)).intentCount).toBe(1);
});
it.skipIf(!enabled)('관측/전략 내용이 바뀐 연결 후보는 DB 의도에 맞춰 고쳐주지 않는다', async () => {
  const input = await fixture();
  input.candidate!.strategy.revision++;
  input.observation.definition.quantity = '6';
  expect((await store.record(await command(input))).receipt).toMatchObject({
    outcome: 'blocked',
    review: { reasons: expect.arrayContaining(['STRATEGY_MISMATCH', 'REQUEST_MISMATCH']) },
  });
  expect((await store.read(input.context.namespace.accountId)).bindingCount).toBe(0);
});
it.skipIf(!enabled)('같은 버전이어도 감사 head hash가 바뀌면 새 명령은 충돌로 영구 기록한다', async () => {
  const input = await fixture(),
    c = await command(input);
  const missing = structuredClone(input);
  missing.candidate!.intentId = randomUUID();
  expect((await store.record(await command(missing))).receipt.outcome).toBe('unassigned');
  expect((await store.record(c)).receipt.outcome).toBe('conflict');
  expect(await store.read(input.context.namespace.accountId)).toMatchObject({
    version: 1,
    bindingCount: 0,
    eventCount: 2,
  });
});
it.skipIf(!enabled)('다른 계좌에서 같은 전역 binding UUID를 재사용하면 전체 연결이 rollback된다', async () => {
  const first = await fixture();
  await store.record(await command(first));
  const second = await fixture();
  second.candidate!.bindingId = first.candidate!.bindingId;
  await expect(store.record(await command(second))).rejects.toThrow('ORDER_BINDING_TRANSACTION_FAILED');
  expect(await store.read(second.context.namespace.accountId)).toMatchObject({
    intentCount: 1,
    bindingCount: 0,
    eventCount: 0,
  });
  expect((await store.read(first.context.namespace.accountId)).bindingCount).toBe(1);
});
it.skipIf(!enabled)('SQL 고유 키도 같은 계좌 주문의 중복 삽입을 거부한다', async () => {
  const input = await fixture();
  await store.record(await command(input));
  const [bound] = await db.db.select().from(bindings).where(eq(bindings.bindingId, input.candidate!.bindingId));
  await expect(db.db.insert(bindings).values({ ...bound!, bindingId: randomUUID() })).rejects.toThrow();
  expect((await store.read(input.context.namespace.accountId)).bindingCount).toBe(1);
});
it.skipIf(!enabled)('계좌 namespace 수정과 과거 버전으로 되돌리기도 SQL에서 거부한다', async () => {
  const input = await fixture(),
    id = input.context.namespace.accountId;
  await expect(
    db.db.update(accounts).set({ brokerId: 'other-broker' }).where(eq(accounts.accountId, id)),
  ).rejects.toThrow();
  await expect(
    db.db.update(accounts).set({ version: 0, intentCount: 0 }).where(eq(accounts.accountId, id)),
  ).rejects.toThrow();
  expect((await store.read(id)).intentCount).toBe(1);
});
it.skipIf(!enabled)('의도 256개 한도에서도 기존 재조회는 허용하고 새 등록은 차단한다', async () => {
  const input = syntheticBindingFixture(),
    initial = await store.initialize(initialize(input));
  const payloads = Array.from({ length: 256 }, () => ({
    ...input.intent!,
    intentId: randomUUID(),
    dedupeKey: contentHash(randomUUID()),
  }));
  await db.db.insert(intents).values(
    payloads.map((payload, index) => ({
      accountId: initial.accountId,
      intentId: payload.intentId,
      dedupeKey: payload.dedupeKey,
      payload,
      payloadHash: contentHash(payload),
      createdVersion: index + 1,
    })),
  );
  // Build a bounded synthetic database fixture; financial/permission flags are not account columns.
  const state = {
    accountId: initial.accountId,
    brokerId: initial.brokerId,
    environment: initial.environment,
    scope: initial.scope,
    version: 256,
    intentCount: 256,
    bindingCount: 0,
    eventCount: 0,
    lastReceiptHash: null,
  };
  await db.db
    .update(accounts)
    .set({ ...state, stateHash: contentHash(state) })
    .where(eq(accounts.accountId, initial.accountId));
  const full = await store.read(initial.accountId);
  expect(
    (
      await store.recordIntent({
        source: 'synthetic-fixture',
        intent: payloads[0],
        expectedVersion: 0,
        expectedStateHash: initial.stateHash,
      })
    ).replayed,
  ).toBe(true);
  await expect(
    store.recordIntent({
      source: 'synthetic-fixture',
      intent: input.intent,
      expectedVersion: full.version,
      expectedStateHash: full.stateHash,
    }),
  ).rejects.toThrow('ORDER_BINDING_LIMIT');
  expect((await store.read(initial.accountId)).intentCount).toBe(256);
});
it.skipIf(!enabled)(
  '512개 이력을 전부 검증하고 한도 도달 후 동일 요청 재조회만 허용한다',
  async () => {
    const input = syntheticBindingFixture(),
      initial = await store.initialize(initialize(input)),
      c = await command(input);
    const first = await store.record(c);
    let previous = first.receipt.receiptHash;
    const extra = [];
    for (let sequence = 2; sequence <= 512; sequence++) {
      const prefix = {
        accountId: initial.accountId,
        brokerId: initial.brokerId,
        environment: initial.environment,
        scope: initial.scope,
        version: 0,
        intentCount: 0,
        bindingCount: 0,
        eventCount: sequence - 1,
        lastReceiptHash: previous,
      };
      const request = { ...c, operationId: randomUUID(), expectedStateHash: contentHash(prefix) },
        requestHash = contentHash(request);
      const base = Object.fromEntries(Object.entries(first.receipt).filter(([key]) => key !== 'receiptHash'));
      const payload = {
        ...base,
        operationId: request.operationId,
        sequence,
        requestHash,
        previousReceiptHash: previous,
      };
      const receipt = { ...payload, receiptHash: contentHash(payload) };
      extra.push({
        accountId: initial.accountId,
        operationId: request.operationId,
        sequence,
        bindingId: null,
        request,
        requestHash,
        receipt,
        receiptHash: receipt.receiptHash,
      });
      previous = receipt.receiptHash;
    }
    await db.db.insert(events).values(extra);
    const state = {
      accountId: initial.accountId,
      brokerId: initial.brokerId,
      environment: initial.environment,
      scope: initial.scope,
      version: 0,
      intentCount: 0,
      bindingCount: 0,
      eventCount: 512,
      lastReceiptHash: previous,
    };
    await db.db
      .update(accounts)
      .set({ ...state, stateHash: contentHash(state) })
      .where(eq(accounts.accountId, initial.accountId));
    expect((await store.read(initial.accountId)).eventCount).toBe(512);
    expect((await other.record(c)).replayed).toBe(true);
    await expect(store.record(await command(input))).rejects.toThrow('ORDER_BINDING_LIMIT');
    expect((await store.read(initial.accountId)).eventCount).toBe(512);
  },
  30000,
);
it.skipIf(!enabled)('새 합성 연결 처리는 기존 Paper 계좌와 대사 스트림을 변경하지 않는다', async () => {
  const paper = await accountFixture(db),
    reviewInput = reviewFixture();
  const reviewStore = createSyntheticOrderReviewStore(db, testDatabaseUrl());
  const reviewBefore = await reviewStore.initialize(reviewInput);
  const paperBefore = await db.db.select().from(paperAccounts).where(eq(paperAccounts.id, paper.id));
  const input = await fixture();
  await store.record(await command(input));
  expect(await reviewStore.read(reviewInput.id)).toEqual(reviewBefore);
  expect(await db.db.select().from(paperAccounts).where(eq(paperAccounts.id, paper.id))).toEqual(paperBefore);
});
it.skipIf(!enabled)('미배정 관측 뒤 의도를 사후 생성하거나 새 UUID로 같은 주문을 편입하지 못한다', async () => {
  const input = syntheticBindingFixture();
  await store.initialize(initialize(input));
  const original = await command(input);
  expect((await store.record(original)).receipt.outcome).toBe('unassigned');
  await expect(seed(input)).rejects.toThrow('ORDER_BINDING_REVIEW_REQUIRED');
  const changed = structuredClone(input);
  changed.intent!.intentId = randomUUID();
  changed.intent!.dedupeKey = contentHash(randomUUID());
  changed.candidate!.intentId = changed.intent!.intentId;
  changed.candidate!.dedupeKey = changed.intent!.dedupeKey;
  changed.candidate!.bindingId = randomUUID();
  changed.attempt!.intentId = changed.intent!.intentId;
  changed.acknowledgement!.intentId = changed.intent!.intentId;
  await seed(changed);
  await expect(store.record(await command(changed))).rejects.toThrow('ORDER_BINDING_REVIEW_REQUIRED');
  expect((await store.record(original)).replayed).toBe(true);
  expect(await store.read(input.context.namespace.accountId)).toMatchObject({ bindingCount: 0, eventCount: 1 });
});
it.skipIf(!enabled)(
  '불확실한 접수를 acceptance로 고치거나 같은 의도의 주문 참조를 바꿔 자동 연결하지 못한다',
  async () => {
    const input = await fixture();
    input.acknowledgement!.kind = 'synthetic-uncertain';
    expect((await store.record(await command(input))).receipt.outcome).toBe('unassigned');
    input.acknowledgement!.kind = 'synthetic-acceptance';
    input.candidate!.orderReference =
      input.observation.orderReference =
      input.acknowledgement!.orderReference =
        `other-${randomUUID()}`;
    await expect(store.record(await command(input))).rejects.toThrow('ORDER_BINDING_REVIEW_REQUIRED');
    expect((await store.read(input.context.namespace.accountId)).bindingCount).toBe(0);
  },
);
