import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { contentHash, createDatabase } from '@hth/database';
import { createSyntheticOrderReviewStore, migrateTestDatabase, testDatabaseUrl } from '@hth/database/testing';
import type { BrokerOrder } from '@hth/broker';
import { syntheticOrder } from '../test/order-review-fixture.js';
import { toOrderObservation } from './order-observation.js';
import { createSyntheticOrderReviewSession } from './synthetic-order-review.js';
import type { SyntheticOrderReviewCommand } from './synthetic-order-review.js';
const enabled = Boolean(process.env.TEST_DATABASE_URL);
let db: ReturnType<typeof createDatabase>;
let store: ReturnType<typeof createSyntheticOrderReviewStore>;
beforeAll(async () => {
  if (!enabled) return;
  db = createDatabase(testDatabaseUrl());
  await migrateTestDatabase(db);
  store = createSyntheticOrderReviewStore(db, testDatabaseUrl());
}, 30000);
afterAll(async () => {
  await db?.close();
});
async function fixture() {
  const id = randomUUID(),
    scope = contentHash(randomUUID());
  const observation = toOrderObservation(syntheticOrder(), { scope, observedAt: '2026-11-12T01:00:01.000Z' });
  await store.initialize({ id, source: 'synthetic-fixture', observation });
  return {
    id,
    scope,
    config: { source: 'synthetic-fixture', streamId: id, maxOperations: 10 },
    async command(order: BrokerOrder, observedAt: string, target = store): Promise<SyntheticOrderReviewCommand> {
      const current = await target.read(id);
      return {
        source: 'synthetic-fixture',
        streamId: id,
        operationId: randomUUID(),
        expectedVersion: current.version,
        expectedObservationHash: current.observationHash,
        observation: toOrderObservation(order, { scope, observedAt }),
      };
    },
  };
}
function filled(quantity: '2' | '3' | '5', commission: string = quantity): BrokerOrder {
  return {
    ...syntheticOrder(),
    status: { value: quantity === '5' ? 'FILLED' : 'PARTIAL_FILLED', known: true },
    execution: {
      quantity,
      amount: quantity === '2' ? '200' : quantity === '3' ? '300' : '500',
      averagePrice: '100',
      commission,
      tax: '0',
      lastFilledAt: '2026-11-12T01:00:05.000Z',
      settlementDate: null,
    },
  };
}
it.skipIf(!enabled)('부분 체결 뒤 중단/새 연결/원래 요청 재확인/추가 체결/늦은 비용을 중복 없이 연결한다', async () => {
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('NETWORK_FORBIDDEN'));
  const firstDb = createDatabase(testDatabaseUrl()),
    restartedDb = createDatabase(testDatabaseUrl());
  let firstClosed = false;
  try {
    const f = await fixture(),
      controller = new AbortController();
    const firstStore = createSyntheticOrderReviewStore(firstDb, testDatabaseUrl());
    const original = await f.command(filled('2'), '2026-11-12T01:00:10.000Z', firstStore);
    const firstSource = { next: vi.fn().mockResolvedValue(original), close: vi.fn().mockResolvedValue(undefined) };
    const firstSession = createSyntheticOrderReviewSession(
      {
        read: firstStore.read,
        async record(command) {
          const result = await firstStore.record(command);
          controller.abort();
          return result;
        },
      },
      firstSource,
    );
    expect(await firstSession.run(f.config, controller.signal)).toMatchObject({
      outcome: 'canceled',
      committed: 1,
      checkpointConfirmed: true,
    });
    expect(firstSource.next).toHaveBeenCalledTimes(1);
    expect(firstSource.close).toHaveBeenCalledTimes(1);
    firstClosed = true;
    await firstDb.close();
    const restarted = createSyntheticOrderReviewStore(restartedDb, testDatabaseUrl());
    const receipts: Awaited<ReturnType<typeof restarted.record>>[] = [];
    let step = 0;
    const source = {
      async next() {
        switch (step++) {
          case 0:
            return original;
          case 1:
            return f.command(filled('3'), '2026-11-12T01:00:20.000Z', restarted);
          case 2:
            return f.command(filled('5'), '2026-11-12T01:00:30.000Z', restarted);
          case 3:
            return f.command(filled('5', '6'), '2026-11-12T01:00:40.000Z', restarted);
          default:
            return null;
        }
      },
      close: vi.fn().mockResolvedValue(undefined),
    };
    const session = createSyntheticOrderReviewSession(
      {
        read: restarted.read,
        async record(command) {
          const r = await restarted.record(command);
          receipts.push(r);
          return r;
        },
      },
      source,
    );
    expect(await session.run(f.config)).toMatchObject({
      outcome: 'completed',
      attempted: 4,
      committed: 3,
      replayed: 1,
      cleanupSucceeded: true,
      ledgerApplied: false,
      canResume: false,
    });
    expect(receipts.map((r) => [r.replayed, r.receipt.report?.outcome, r.receipt.report?.delta?.quantity])).toEqual([
      [true, 'progress', '2'],
      [false, 'progress', '1'],
      [false, 'progress', '2'],
      [false, 'cost-adjustment', '0'],
    ]);
    expect(receipts[3]?.receipt.report?.delta?.commission).toBe('1');
    expect(await restarted.read(f.id)).toMatchObject({
      eventCount: 4,
      version: 4,
      status: 'ready',
      observation: { state: 'filled', execution: { quantity: '5', amount: '500', commission: '6' } },
    });
    expect(source.close).toHaveBeenCalledTimes(1);
    expect(network).not.toHaveBeenCalled();
  } finally {
    try {
      await Promise.all([firstClosed ? Promise.resolve() : firstDb.close(), restartedDb.close()]);
    } finally {
      network.mockRestore();
    }
  }
});
it.skipIf(!enabled)('커밋 응답이 유실되면 멈추고 별도 세션의 동일 요청 확인만 저장 receipt를 반환한다', async () => {
  const f = await fixture(),
    command = await f.command(filled('2'), '2026-11-12T01:00:10.000Z');
  const source = { next: vi.fn().mockResolvedValue(command), close: vi.fn().mockResolvedValue(undefined) };
  const uncertain = createSyntheticOrderReviewSession(
    {
      read: store.read,
      async record(input) {
        await store.record(input);
        throw new Error('LOST_RESPONSE_PRIVATE');
      },
    },
    source,
  );
  const result = await uncertain.run(f.config);
  expect(result).toMatchObject({
    outcome: 'failed',
    reason: 'record-failed',
    attempted: 1,
    committed: 0,
    recordOutcomeUncertain: true,
  });
  expect(source.next).toHaveBeenCalledTimes(1);
  expect((await store.read(f.id)).eventCount).toBe(1);
  const nextSource = {
    next: vi.fn().mockResolvedValueOnce(command).mockResolvedValue(null),
    close: vi.fn().mockResolvedValue(undefined),
  };
  expect(await createSyntheticOrderReviewSession(store, nextSource).run(f.config)).toMatchObject({
    outcome: 'completed',
    committed: 0,
    replayed: 1,
    recordOutcomeUncertain: false,
  });
  expect((await store.read(f.id)).eventCount).toBe(1);
});
it.skipIf(!enabled)('불명확한 주문 상태는 보류로 끝나며 새 세션도 source를 읽지 않는다', async () => {
  const f = await fixture();
  const command = await f.command(
    { ...syntheticOrder(), status: { known: false, value: 'NEW_STATUS' } },
    '2026-11-12T01:00:10.000Z',
  );
  const source = { next: vi.fn().mockResolvedValue(command), close: vi.fn().mockResolvedValue(undefined) };
  expect(await createSyntheticOrderReviewSession(store, source).run(f.config)).toMatchObject({
    outcome: 'held',
    committed: 1,
  });
  const nextSource = { next: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
  expect((await createSyntheticOrderReviewSession(store, nextSource).run(f.config)).outcome).toBe('held');
  expect(nextSource.next).not.toHaveBeenCalled();
  expect(await store.read(f.id)).toMatchObject({
    status: 'quarantined',
    eventCount: 1,
    observation: { execution: { quantity: '0' } },
  });
});
it.skipIf(!enabled)('오래된 기대 기준의 새 작업은 충돌로 종료하고 자동 재작성하지 않는다', async () => {
  const f = await fixture();
  const first = await f.command(filled('2'), '2026-11-12T01:00:10.000Z');
  const stale = await f.command(filled('3'), '2026-11-12T01:00:20.000Z');
  await store.record(first);
  const source = { next: vi.fn().mockResolvedValue(stale), close: vi.fn().mockResolvedValue(undefined) };
  expect(await createSyntheticOrderReviewSession(store, source).run(f.config)).toMatchObject({
    outcome: 'conflict',
    committed: 1,
    attempted: 1,
  });
  expect(source.next).toHaveBeenCalledTimes(1);
  expect(await store.read(f.id)).toMatchObject({
    eventCount: 2,
    version: 1,
    observation: { execution: { quantity: '2' } },
  });
});
it.skipIf(!enabled)('합성 취소 완료의 부분 체결을 보존하고 이후 체결량 증가를 보류한다', async () => {
  const f = await fixture();
  const partial = await f.command(filled('2'), '2026-11-12T01:00:10.000Z');
  await store.record(partial);
  const canceled = {
    ...filled('2'),
    status: { value: 'CANCELED', known: true },
    canceledAt: '2026-11-12T01:00:15.000Z',
  };
  let step = 0;
  const source = {
    async next() {
      return step++ === 0
        ? f.command(canceled, '2026-11-12T01:00:20.000Z')
        : f.command(filled('3'), '2026-11-12T01:00:30.000Z');
    },
    close: vi.fn().mockResolvedValue(undefined),
  };
  expect((await createSyntheticOrderReviewSession(store, source).run(f.config)).outcome).toBe('held');
  expect(await store.read(f.id)).toMatchObject({
    status: 'quarantined',
    eventCount: 3,
    observation: { state: 'canceled', execution: { quantity: '2' } },
  });
});
