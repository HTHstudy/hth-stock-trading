import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { OrderObservation, SyntheticOrderBindingInput } from '@hth/contracts';
import { createDatabase, contentHash } from './index.js';
import { createSyntheticOrderBindingStore } from './synthetic-order-binding.js';
import { createSyntheticLedgerStore } from './synthetic-ledger.js';
import {
  syntheticLedgerAccounts as accounts,
  syntheticLedgerObservations as observations,
  syntheticLedgerMutations as mutations,
} from './schema.js';
import { testDatabaseUrl, migrateTestDatabase } from '../test/setup.js';
import { syntheticBindingFixture, syntheticBindingEvidence } from '../test/synthetic-binding-fixtures.js';
const enabled = Boolean(process.env.TEST_DATABASE_URL);
let db: ReturnType<typeof createDatabase>, otherDb: ReturnType<typeof createDatabase>;
let binding: ReturnType<typeof createSyntheticOrderBindingStore>,
  store: ReturnType<typeof createSyntheticLedgerStore>,
  other: typeof store;
beforeAll(async () => {
  if (!enabled) return;
  db = createDatabase(testDatabaseUrl());
  otherDb = createDatabase(testDatabaseUrl());
  await migrateTestDatabase(db);
  binding = createSyntheticOrderBindingStore(db, testDatabaseUrl());
  store = createSyntheticLedgerStore(db, testDatabaseUrl());
  other = createSyntheticLedgerStore(otherDb, testDatabaseUrl());
}, 30000);
afterAll(async () => {
  await Promise.all([db?.close(), otherDb?.close()]);
});
async function bind(p: SyntheticOrderBindingInput) {
  await binding.initialize({ source: 'synthetic-fixture', namespace: p.context.namespace, scope: p.context.scope });
  let current = await binding.read(p.context.namespace.accountId);
  await binding.recordIntent({
    source: 'synthetic-fixture',
    intent: p.intent,
    expectedVersion: current.version,
    expectedStateHash: current.stateHash,
  });
  current = await binding.read(p.context.namespace.accountId);
  expect(
    (
      await binding.record({
        source: 'synthetic-fixture',
        operationId: randomUUID(),
        expectedVersion: current.version,
        expectedStateHash: current.stateHash,
        evidence: syntheticBindingEvidence(p),
      })
    ).receipt.outcome,
  ).toBe('bound');
}
async function fixture(register = true) {
  const p = syntheticBindingFixture();
  p.observation.execution.amount = p.observation.execution.commission = p.observation.execution.tax = '0';
  await bind(p);
  const id = p.context.namespace.accountId,
    keys = { source: 'synthetic-fixture', accountId: id, bindingId: p.candidate!.bindingId };
  const initial = {
    source: 'synthetic-fixture',
    namespace: p.context.namespace,
    scope: p.context.scope,
    cash: { KRW: '100000', USD: '2000' },
    positions: [{ instrument: p.observation.instrument, manualQuantity: '10' }],
  };
  await store.initialize(initial);
  const c = await store.read(id);
  const registration = {
    ...keys,
    expectedVersion: c.state.version,
    expectedStateHash: c.stateHash,
    baseline: p.observation,
    reservedCash: '600',
    reservedQuantity: '0',
  };
  if (register) expect((await store.register(registration)).outcome).toBe('stored');
  return { p, id, keys, initial, registration };
}
function observed(
  p: SyntheticOrderBindingInput,
  q: string,
  time: number,
  amount = String(Number(q) * 100),
  fee = q,
): OrderObservation {
  return {
    ...structuredClone(p.observation),
    observedAt: `2026-11-12T01:00:${String(time).padStart(2, '0')}.000Z`,
    state: q === p.observation.definition.quantity ? 'filled' : 'partial',
    execution: {
      quantity: q,
      amount,
      commission: fee,
      tax: '0',
      averagePrice: '100',
      lastFilledAt: '2026-11-12T01:00:05.000Z',
      settlementDate: null,
    },
  };
}
async function application(f: Awaited<ReturnType<typeof fixture>>, sequence: number, obs: OrderObservation) {
  const saved = await store.observe({ ...f.keys, sequence, observation: obs }),
    current = await store.read(f.id);
  return {
    ...f.keys,
    sequence,
    expectedVersion: current.state.version,
    expectedStateHash: current.stateHash,
    expectedObservationHash: saved.observationHash,
  };
}
it.skipIf(!enabled)('불변 관측 0→2→3→5를 저장하고 신규분만 금융 모델에 원자적으로 반영한다', async () => {
  const f = await fixture(),
    before = await binding.read(f.id),
    quantities = [];
  for (const [i, q] of ['2', '3', '5'].entries()) {
    const r = await store.apply(await application(f, i + 1, observed(f.p, q, 10 + i)));
    expect(r.outcome).toBe('stored');
    if (r.outcome === 'stored') quantities.push(r.receipt.effect?.quantity);
  }
  expect(quantities).toEqual(['2', '1', '2']);
  expect((await store.read(f.id)).state).toMatchObject({
    version: 4,
    cash: { USD: '1495', KRW: '100000' },
    positions: [{ manualQuantity: '10', owners: [{ quantity: '5', basis: '505' }] }],
  });
  expect(await binding.read(f.id)).toEqual(before);
  expect(await db.db.select().from(mutations).where(eq(mutations.accountId, f.id))).toHaveLength(4);
});
it.skipIf(!enabled)('두 pool의 동일 적용 요청은 하나의 mutation과 같은 역사 receipt를 반환한다', async () => {
  const f = await fixture(),
    c = await application(f, 1, observed(f.p, '2', 10));
  const results = await Promise.all([store.apply(c), other.apply(c)]);
  expect(results.map((r) => r.outcome === 'stored' && r.replayed).sort()).toEqual([false, true]);
  if (results[0]!.outcome === 'stored' && results[1]!.outcome === 'stored')
    expect(results[0].receipt).toEqual(results[1].receipt);
  expect((await store.read(f.id)).state.cash.USD).toBe('1798');
  expect(await db.db.select().from(mutations).where(eq(mutations.accountId, f.id))).toHaveLength(2);
});
it.skipIf(!enabled)('관측 키의 내용을 바꾸거나 sequence를 건너뛰어 새 원본을 만들지 못한다', async () => {
  const f = await fixture(),
    obs = observed(f.p, '2', 10);
  await application(f, 1, obs);
  expect((await store.observe({ ...f.keys, sequence: 1, observation: obs })).replayed).toBe(true);
  await expect(store.observe({ ...f.keys, sequence: 1, observation: observed(f.p, '3', 11) })).rejects.toThrow(
    'SYNTHETIC_LEDGER_CONFLICT',
  );
  await expect(store.observe({ ...f.keys, sequence: 3, observation: obs })).rejects.toThrow(
    'SYNTHETIC_LEDGER_CONFLICT',
  );
});
it.skipIf(!enabled)('잘못된 첫 관측을 저장한 뒤 다음 정상 관측으로 미적용 구간을 건너뛰지 못한다', async () => {
  const f = await fixture(),
    bad = observed(f.p, '2', 10);
  bad.execution.commission = null;
  const first = await application(f, 1, bad),
    second = await application(f, 2, observed(f.p, '3', 11)),
    before = await store.read(f.id);
  expect((await store.apply(first)).outcome).toBe('blocked');
  expect(await store.apply(second)).toMatchObject({ outcome: 'blocked', reason: 'SEQUENCE_INVALID' });
  expect(await store.read(f.id)).toEqual(before);
  expect(await db.db.select().from(observations).where(eq(observations.accountId, f.id))).toHaveLength(2);
});
it.skipIf(!enabled)('관측은 유지하고 낡은 asset version/hash의 새 적용은 자동 재시도하지 않는다', async () => {
  const f = await fixture(),
    first = await application(f, 1, observed(f.p, '2', 10)),
    stale = await application(f, 2, observed(f.p, '3', 11));
  await store.apply(first);
  await expect(store.apply(stale)).rejects.toThrow('SYNTHETIC_LEDGER_CONFLICT');
  const current = await store.read(f.id);
  expect(
    (await store.apply({ ...stale, expectedVersion: current.state.version, expectedStateHash: current.stateHash }))
      .outcome,
  ).toBe('stored');
  expect((await store.read(f.id)).state.cash.USD).toBe('1697');
});
it.skipIf(!enabled)('커밋 후 응답 유실/재접속/과거 요청 확인은 현금과 최신 checkpoint를 되돌리지 않는다', async () => {
  const f = await fixture(),
    first = await application(f, 1, observed(f.p, '2', 10)),
    r = await store.apply(first);
  expect(r.outcome).toBe('stored');
  await expect(
    (async () => {
      await store.apply(first);
      throw new Error('SYNTHETIC_LOST_RESPONSE');
    })(),
  ).rejects.toThrow('SYNTHETIC_LOST_RESPONSE');
  await store.apply(await application(f, 2, observed(f.p, '3', 11)));
  const reconnectDb = createDatabase(testDatabaseUrl());
  try {
    const reconnect = createSyntheticLedgerStore(reconnectDb, testDatabaseUrl());
    const replay = await reconnect.apply(first);
    expect(replay).toMatchObject({ outcome: 'stored', replayed: true });
    if (r.outcome === 'stored' && replay.outcome === 'stored') expect(replay.receipt).toEqual(r.receipt);
    expect((await reconnect.read(f.id)).state).toMatchObject({
      version: 3,
      cash: { USD: '1697' },
      orders: [{ sequence: 2 }],
    });
  } finally {
    await reconnectDb.close();
  }
});
it.skipIf(!enabled)('최종 aggregate 저장 실패는 적용 이력과 금융 상태를 모두 rollback한다', async () => {
  const f = await fixture(),
    c = await application(f, 1, observed(f.p, '2', 10)),
    before = await store.read(f.id);
  const original = db.db.transaction.bind(db.db),
    spy = vi.spyOn(db.db, 'transaction');
  spy.mockImplementationOnce((operation, config) =>
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
    await expect(store.apply(c)).rejects.toThrow('ORDER_BINDING_TRANSACTION_FAILED');
  } finally {
    spy.mockRestore();
  }
  expect(await store.read(f.id)).toEqual(before);
  expect(await db.db.select().from(mutations).where(eq(mutations.accountId, f.id))).toHaveLength(1);
  expect((await store.apply(c)).outcome).toBe('stored');
});
it.skipIf(!enabled)('재초기화와 등록 재조회는 자금/기존 예약/영구 적용 키를 초기화하지 않는다', async () => {
  const f = await fixture();
  await store.apply(await application(f, 1, observed(f.p, '5', 10)));
  expect((await store.initialize(f.initial)).state.cash.USD).toBe('1495');
  expect(await store.register(f.registration)).toMatchObject({ outcome: 'stored', replayed: true });
  expect((await store.read(f.id)).state.orders[0]!.reservedCash).toBe('0');
  await expect(store.initialize({ ...f.initial, cash: { ...f.initial.cash, USD: '9999' } })).rejects.toThrow(
    'SYNTHETIC_LEDGER_CONFLICT',
  );
});
it.skipIf(!enabled)('DB에 연결되지 않은 임의 binding/proof로 금융 모델을 등록하지 못한다', async () => {
  const f = await fixture(false);
  await expect(store.register({ ...f.registration, bindingId: randomUUID() })).rejects.toThrow(
    'SYNTHETIC_LEDGER_BINDING_INVALID',
  );
  await expect(store.register({ ...f.registration, proof: f.p })).rejects.toThrow('SYNTHETIC_LEDGER_INPUT_INVALID');
  expect((await store.read(f.id)).state.orders).toHaveLength(0);
});
it.skipIf(!enabled)('관측/적용 이력의 수정·삭제와 동일 적용 키의 직접 SQL 삽입을 거부한다', async () => {
  const f = await fixture();
  await store.apply(await application(f, 1, observed(f.p, '2', 10)));
  await expect(db.db.delete(observations).where(eq(observations.accountId, f.id))).rejects.toThrow();
  await expect(
    db.db
      .update(mutations)
      .set({ afterHash: '0'.repeat(64) })
      .where(eq(mutations.accountId, f.id)),
  ).rejects.toThrow();
  const rows = await db.db.select().from(mutations).where(eq(mutations.accountId, f.id)),
    applied = rows.find((r) => r.kind === 'apply')!;
  await expect(db.db.insert(mutations).values({ ...applied, version: 9 })).rejects.toThrow();
  expect((await store.read(f.id)).state.cash.USD).toBe('1798');
});
it.skipIf(!enabled)('이미 부분 체결인 최초 바인딩에 영(0) 기준을 사후 부여할 수 없다', async () => {
  const f = await fixture(false),
    other = syntheticBindingFixture();
  other.observation = observed(other, '2', 10);
  await bind(other);
  await store.initialize({ ...f.initial, namespace: other.context.namespace, scope: other.context.scope });
  const current = await store.read(other.context.namespace.accountId),
    zero = { ...f.p.observation, scope: other.context.scope, orderReference: other.observation.orderReference };
  await expect(
    store.register({
      source: 'synthetic-fixture',
      accountId: other.context.namespace.accountId,
      bindingId: other.candidate!.bindingId,
      expectedVersion: 0,
      expectedStateHash: current.stateHash,
      baseline: zero,
      reservedCash: '600',
      reservedQuantity: '0',
    }),
  ).rejects.toThrow('SYNTHETIC_LEDGER_BINDING_INVALID');
});
it.skipIf(!enabled)('매도도 같은 저장 경로에서 자기 소유 원가만 해제하고 수동 보유와 현금을 보존한다', async () => {
  const f = await fixture();
  await store.apply(await application(f, 1, observed(f.p, '5', 10)));
  const sell = syntheticBindingFixture();
  sell.context = { ...f.p.context };
  sell.observationNamespace = { ...f.p.context.namespace };
  sell.observation.scope = f.p.context.scope;
  for (const r of [sell.candidate!, sell.intent!, sell.attempt!, sell.acknowledgement!])
    r.namespace = { ...f.p.context.namespace };
  sell.intent!.request.side = sell.observation.side = 'SELL';
  sell.intent!.request.definition.quantity = sell.observation.definition.quantity = '3';
  sell.observation.execution.amount = sell.observation.execution.commission = sell.observation.execution.tax = '0';
  const requestHash = contentHash(sell.intent!.request);
  for (const r of [sell.candidate!, sell.intent!, sell.attempt!, sell.acknowledgement!]) r.requestHash = requestHash;
  await bind(sell);
  const current = await store.read(f.id),
    keys = { source: 'synthetic-fixture', accountId: f.id, bindingId: sell.candidate!.bindingId };
  expect(
    (
      await store.register({
        ...keys,
        expectedVersion: current.state.version,
        expectedStateHash: current.stateHash,
        baseline: sell.observation,
        reservedCash: '0',
        reservedQuantity: '3',
      })
    ).outcome,
  ).toBe('stored');
  const stored = await store.observe({ ...keys, sequence: 1, observation: observed(sell, '3', 20, '360', '3') }),
    before = await store.read(f.id);
  expect(
    (
      await store.apply({
        ...keys,
        sequence: 1,
        expectedVersion: before.state.version,
        expectedStateHash: before.stateHash,
        expectedObservationHash: stored.observationHash,
      })
    ).outcome,
  ).toBe('stored');
  expect((await store.read(f.id)).state).toMatchObject({
    cash: { USD: '1495' },
    receivables: { USD: '357' },
    realizedPnl: { USD: '54' },
    positions: [{ manualQuantity: '10', owners: [{ quantity: '2', basis: '202' }] }],
  });
});
it.skipIf(!enabled)('늦은 비용은 원가를 덮어쓰지 않고 이후 관측으로도 건너뛰지 못한다', async () => {
  const f = await fixture();
  await store.apply(await application(f, 1, observed(f.p, '5', 10)));
  const late = observed(f.p, '5', 20);
  late.execution.commission = '6';
  expect(await store.apply(await application(f, 2, late))).toMatchObject({
    outcome: 'blocked',
    reason: 'COST_REVIEW_REQUIRED',
  });
  expect(await store.apply(await application(f, 3, observed(f.p, '5', 21)))).toMatchObject({
    outcome: 'blocked',
    reason: 'SEQUENCE_INVALID',
  });
  expect((await store.read(f.id)).state.positions[0]!.owners[0]!.basis).toBe('505');
});
it.skipIf(!enabled)('aggregate와 적용 이력 version이 다르면 과거 receipt 재조회도 차단한다', async () => {
  const f = await fixture(),
    c = await application(f, 1, observed(f.p, '2', 10));
  await store.apply(c);
  const current = await store.read(f.id);
  const state = { ...current.state, version: current.state.version + 1 };
  await db.db
    .update(accounts)
    .set({ state, stateHash: contentHash(state), version: state.version })
    .where(eq(accounts.accountId, f.id));
  await expect(store.read(f.id)).rejects.toThrow('SYNTHETIC_LEDGER_INTEGRITY_FAILED');
  await expect(store.apply(c)).rejects.toThrow('SYNTHETIC_LEDGER_INTEGRITY_FAILED');
});
