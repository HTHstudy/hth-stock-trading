import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createDatabase, contentHash } from './index.js';
import { createSyntheticOrderReviewStore } from './order-review.js';
import { orderReviewEvents, orderReviewStreams } from './schema.js';
import { testDatabaseUrl, migrateTestDatabase } from '../test/setup.js';
import { reviewFixture, partial } from '../test/order-review-fixtures.js';
import type { OrderObservation } from '@hth/contracts';
const enabled = Boolean(process.env.TEST_DATABASE_URL);
let database: ReturnType<typeof createDatabase>, other: ReturnType<typeof createDatabase>;
let store: ReturnType<typeof createSyntheticOrderReviewStore>,
  contender: ReturnType<typeof createSyntheticOrderReviewStore>;
beforeAll(async () => {
  if (!enabled) return;
  const url = testDatabaseUrl();
  database = createDatabase(url);
  other = createDatabase(url);
  await migrateTestDatabase(database);
  store = createSyntheticOrderReviewStore(database, url);
  contender = createSyntheticOrderReviewStore(other, url);
}, 30000);
afterAll(async () => {
  await Promise.all([database?.close(), other?.close()]);
});
async function fixture() {
  const input = reviewFixture();
  return { input, current: await store.initialize(input) };
}
function command(
  current: Awaited<ReturnType<typeof store.read>>,
  observation: OrderObservation,
  operationId = randomUUID(),
) {
  return {
    streamId: current.id,
    source: 'synthetic-fixture',
    operationId,
    expectedVersion: current.version,
    expectedObservationHash: current.observationHash,
    observation,
  };
}
const events = async (id: string) =>
  await database.db.select().from(orderReviewEvents).where(eq(orderReviewEvents.streamId, id));
it.skipIf(!enabled)('동일 작업 재전송/동일 관측 재처리는 누적 체결을 두 번 기록하지 않는다', async () => {
  const { input, current } = await fixture(),
    c = command(current, partial(input.observation));
  const first = await store.record(c),
    again = await contender.record(c);
  expect(first.replayed).toBe(false);
  expect(again.replayed).toBe(true);
  expect(again.receipt).toEqual(first.receipt);
  expect(first.receipt).toMatchObject({
    outcome: 'checkpoint-advanced',
    versionAfter: 1,
    report: { outcome: 'progress', delta: { quantity: '2', amount: '200' } },
    ledgerApplied: false,
    canApplyToLedger: false,
  });
  const next = await store.read(input.id);
  const duplicate = await store.record(command(next, partial(input.observation)));
  expect(duplicate.receipt).toMatchObject({
    outcome: 'unchanged',
    versionBefore: 1,
    versionAfter: 1,
    report: { outcome: 'unchanged', delta: null },
  });
  expect(await events(input.id)).toHaveLength(2);
  expect((await store.read(input.id)).version).toBe(1);
});
it.skipIf(!enabled)('동일 작업 ID의 기대 버전/관측 변경을 영구 거부한다', async () => {
  const { input, current } = await fixture(),
    c = command(current, partial(input.observation));
  await store.record(c);
  await expect(store.record({ ...c, expectedVersion: 1 })).rejects.toThrow('ORDER_REVIEW_OPERATION_REUSED');
  await expect(store.record({ ...c, observation: partial(input.observation, '3') })).rejects.toThrow(
    'ORDER_REVIEW_OPERATION_REUSED',
  );
  expect(await events(input.id)).toHaveLength(1);
});
it.skipIf(!enabled)('동일 작업의 동시 호출은 하나의 receipt/기준 변경만 커밋한다', async () => {
  const { input, current } = await fixture(),
    c = command(current, partial(input.observation));
  const results = await Promise.all([store.record(c), contender.record(c)]);
  expect(results.map((r) => r.replayed).sort()).toEqual([false, true]);
  expect(await events(input.id)).toHaveLength(1);
  expect((await store.read(input.id)).version).toBe(1);
});
it.skipIf(!enabled)('다른 작업의 CAS 경합은 한 번만 진행하고 실패도 고정된 receipt로 남긴다', async () => {
  const { input, current } = await fixture(),
    a = command(current, partial(input.observation)),
    b = command(current, partial(input.observation, '3'));
  const results = await Promise.all([store.record(a), contender.record(b)]);
  expect(results.map((r) => r.receipt.outcome).sort()).toEqual(['checkpoint-advanced', 'conflict']);
  const failed = results[0]!.receipt.outcome === 'conflict' ? a : b;
  expect((await store.record(failed)).replayed).toBe(true);
  await expect(store.record({ ...failed, expectedVersion: 1 })).rejects.toThrow('ORDER_REVIEW_OPERATION_REUSED');
  expect((await store.read(input.id)).version).toBe(1);
  expect(await events(input.id)).toHaveLength(2);
});
it.skipIf(!enabled).each(['unknown', 'amount-reversed', 'scope'] as const)(
  '검토/차단 %s 뒤 정상 관측으로 기존 기준을 덮어쓰지 않는다',
  async (kind) => {
    const { input, current } = await fixture();
    await store.record(command(current, partial(input.observation)));
    const before = await store.read(input.id),
      bad = partial(input.observation, '3');
    if (kind === 'unknown') bad.state = 'unknown';
    if (kind === 'amount-reversed') bad.execution.amount = '100';
    if (kind === 'scope') bad.scope = 'b'.repeat(64);
    const held = await store.record(command(before, bad));
    expect(held.receipt.outcome).toBe('review-held');
    const after = await store.read(input.id);
    expect(after.status).toBe('quarantined');
    expect(after.version).toBe(2);
    expect(after.observationHash).toBe(before.observationHash);
    const result = await contender.record(command(after, partial(input.observation, '3', '2026-11-12T01:00:30.000Z')));
    expect(result.receipt.outcome).toBe('held');
    expect((await store.read(input.id)).observationHash).toBe(before.observationHash);
    expect((await store.initialize(input)).status).toBe('quarantined');
    await expect(store.initialize({ ...input, id: randomUUID() })).rejects.toThrow('ORDER_REVIEW_BINDING_EXISTS');
  },
);
it.skipIf(!enabled)('기대 관측 hash 불일치는 버전이 같아도 진행하지 않는다', async () => {
  const { input, current } = await fixture();
  const r = await store.record({
    ...command(current, partial(input.observation)),
    expectedObservationHash: 'f'.repeat(64),
  });
  expect(r.receipt.outcome).toBe('conflict');
  expect((await store.read(input.id)).version).toBe(0);
});
it.skipIf(!enabled)('응답을 잃고 pool을 재생성해도 영구 receipt를 재사용한다', async () => {
  const { input, current } = await fixture(),
    c = command(current, partial(input.observation));
  await store.record(c);
  const reopened = createDatabase(testDatabaseUrl());
  try {
    const recovered = createSyntheticOrderReviewStore(reopened, testDatabaseUrl());
    expect((await recovered.record(c)).replayed).toBe(true);
    expect((await recovered.read(input.id)).version).toBe(1);
  } finally {
    await reopened.close();
  }
});
it.skipIf(!enabled)('원본 기준/요청을 초기화하거나 다른 출처로 바꾸지 않는다', async () => {
  const { input, current } = await fixture();
  await store.record(command(current, partial(input.observation)));
  const repeat = await store.initialize(input);
  expect(repeat.version).toBe(1);
  expect(repeat.initialObservationHash).toBe(contentHash(input.observation));
  const changed = structuredClone(input);
  changed.observation.definition.limitPrice = '111';
  await expect(store.initialize(changed)).rejects.toThrow('ORDER_REVIEW_STREAM_EXISTS');
});
it.skipIf(!enabled)('숫자 표현만 같고 관측 시각이 새로운 경우 watermark만 진행한다', async () => {
  const { input, current } = await fixture(),
    observation = structuredClone(input.observation);
  observation.observedAt = '2026-11-12T01:00:02.000Z';
  observation.execution.quantity = '0.000';
  const r = await store.record(command(current, observation));
  expect(r.receipt).toMatchObject({
    outcome: 'checkpoint-advanced',
    report: { outcome: 'unchanged', delta: null },
    versionAfter: 1,
  });
  const stale = await store.record(command(await store.read(input.id), input.observation));
  expect(stale.receipt).toMatchObject({
    outcome: 'review-held',
    report: { outcome: 'blocked', reasons: ['OBSERVATION_REVERSED'] },
  });
});
it.skipIf(!enabled)('receipt/기준 오염은 재사용하거나 진행하지 않는다', async () => {
  const { input, current } = await fixture(),
    c = command(current, partial(input.observation));
  await store.record(c);
  await database.db
    .update(orderReviewEvents)
    .set({ receiptHash: 'f'.repeat(64) })
    .where(and(eq(orderReviewEvents.streamId, input.id), eq(orderReviewEvents.operationId, c.operationId)));
  await expect(store.record(c)).rejects.toThrow('ORDER_REVIEW_INTEGRITY_FAILED');
  const otherFixture = await fixture();
  await database.db
    .update(orderReviewStreams)
    .set({ observationHash: 'f'.repeat(64) })
    .where(eq(orderReviewStreams.id, otherFixture.input.id));
  await expect(store.read(otherFixture.input.id)).rejects.toThrow('ORDER_REVIEW_INTEGRITY_FAILED');
});
it.skipIf(!enabled)('이벤트 기록 실패는 기준 갱신까지 rollback하고 원본 저장 오류를 숨긴다', async () => {
  const { input, current } = await fixture();
  const original = database.db.transaction.bind(database.db);
  const injected = vi.spyOn(database.db, 'transaction');
  injected.mockImplementationOnce((operation, config) =>
    original(async (tx) => {
      const insert = vi.spyOn(tx, 'insert').mockImplementation(() => {
        throw new Error('PRIVATE_STORAGE_DETAIL');
      });
      try {
        return await operation(tx);
      } finally {
        insert.mockRestore();
      }
    }, config),
  );
  try {
    await expect(store.record(command(current, partial(input.observation)))).rejects.toThrow(
      'ORDER_REVIEW_TRANSACTION_FAILED',
    );
  } finally {
    injected.mockRestore();
  }
  expect((await store.read(input.id)).observationHash).toBe(current.observationHash);
  expect((await store.read(input.id)).version).toBe(0);
  expect(await events(input.id)).toHaveLength(0);
});
it.skipIf(!enabled)('가짜 source의 연속 부분 체결은 중복을 제외한 차이만 영구 기록한다', async () => {
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('NETWORK_FORBIDDEN'));
  try {
    const { input, current } = await fixture(),
      first = command(current, partial(input.observation));
    await store.record(first);
    await contender.record(first);
    const second = command(await store.read(input.id), partial(input.observation, '3', '2026-11-12T01:00:20.000Z'));
    await contender.record(second);
    await store.record(second);
    const rows = await events(input.id);
    expect(rows).toHaveLength(2);
    expect(
      rows.map((r) => (r.receipt as { report: { delta: { quantity: string } } }).report.delta.quantity).sort(),
    ).toEqual(['1', '2']);
    expect((await store.read(input.id)).observation.execution.quantity).toBe('3');
    expect(network).not.toHaveBeenCalled();
  } finally {
    network.mockRestore();
  }
});

it.skipIf(!enabled)('과거 receipt의 hash를 다시 만들어도 후속 연결이 깨지면 새 관측을 받지 않는다', async () => {
  const { input, current } = await fixture();
  const firstCommand = command(current, partial(input.observation));
  const first = await store.record(firstCommand);
  const secondCommand = command(
    await store.read(input.id),
    partial(input.observation, '3', '2026-11-12T01:00:20.000Z'),
  );
  await store.record(secondCommand);
  const checkpoint = await store.read(input.id);
  const changed = structuredClone(first.receipt);
  changed.report!.delta!.quantity = '999';
  const { receiptHash: originalHash, ...payload } = changed;
  expect(originalHash).toBe(first.receipt.receiptHash);
  const receipt = { ...payload, receiptHash: contentHash(payload) };
  await database.db
    .update(orderReviewEvents)
    .set({ receipt, receiptHash: receipt.receiptHash })
    .where(and(eq(orderReviewEvents.streamId, input.id), eq(orderReviewEvents.operationId, firstCommand.operationId)));
  await expect(store.read(input.id)).rejects.toThrow('ORDER_REVIEW_INTEGRITY_FAILED');
  await expect(store.record(command(checkpoint, checkpoint.observation))).rejects.toThrow(
    'ORDER_REVIEW_INTEGRITY_FAILED',
  );
});
it.skipIf(!enabled)('과거 이벤트 삭제를 새 작업/초기화로 복구하거나 무시하지 않는다', async () => {
  const { input, current } = await fixture();
  const c = command(current, partial(input.observation));
  await store.record(c);
  const checkpoint = await store.read(input.id);
  await database.db
    .delete(orderReviewEvents)
    .where(and(eq(orderReviewEvents.streamId, input.id), eq(orderReviewEvents.operationId, c.operationId)));
  await expect(store.record(command(checkpoint, checkpoint.observation))).rejects.toThrow(
    'ORDER_REVIEW_INTEGRITY_FAILED',
  );
  await expect(store.initialize(input)).rejects.toThrow('ORDER_REVIEW_INTEGRITY_FAILED');
});
it.skipIf(!enabled)('오래된 응답 재처리는 더 최신 대사 기준을 복원하지 않는다', async () => {
  const { input, current } = await fixture(),
    first = command(current, partial(input.observation));
  const result = await store.record(first);
  await store.record(command(await store.read(input.id), partial(input.observation, '3', '2026-11-12T01:00:20.000Z')));
  const replay = await contender.record(first);
  expect(replay).toEqual({ replayed: true, receipt: result.receipt });
  expect(replay.receipt.versionAfter).toBe(1);
  expect((await store.read(input.id)).version).toBe(2);
});
it.skipIf(!enabled)('KRW 합성 주문도 통화 변환 없이 누적 문자열을 보존한다', async () => {
  const input = reviewFixture();
  input.observation.instrument = { market: 'KR', symbol: '005930' };
  input.observation.currency = 'KRW';
  input.observation.definition.limitPrice = '70000';
  const current = await store.initialize(input),
    next = partial(input.observation);
  next.execution.averagePrice = '70000';
  next.execution.amount = '140000';
  next.execution.commission = '21';
  const r = await store.record(command(current, next));
  expect(r.receipt.report?.delta).toEqual({ quantity: '2', amount: '140000', commission: '21', tax: '0' });
  expect((await store.read(input.id)).observation.currency).toBe('KRW');
});
