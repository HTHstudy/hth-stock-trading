import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createDatabase, contentHash } from '@hth/database';
import { createSyntheticOrderReviewStore, migrateTestDatabase, testDatabaseUrl } from '@hth/database/testing';
import type { BrokerOrder } from '@hth/broker';
import { toOrderObservation } from './order-observation.js';
function syntheticOrder(): BrokerOrder {
  return {
    reference: 'synthetic-source-order',
    instrument: { market: 'US', symbol: 'AAPL' },
    side: 'BUY',
    currency: 'USD',
    type: { value: 'LIMIT', known: true },
    validity: { value: 'DAY', known: true },
    status: { value: 'PENDING', known: true },
    requestedQuantity: '5',
    limitPrice: '110',
    requestedAmount: null,
    orderedAt: '2026-11-12T01:00:00.000Z',
    execution: {
      quantity: '0',
      averagePrice: null,
      amount: '0',
      commission: '0',
      tax: '0',
      lastFilledAt: null,
      settlementDate: null,
    },
  };
}
it.skipIf(!process.env.TEST_DATABASE_URL)(
  '가짜 주문 source→worker 변환→영구 대사 기준의 중복/증가 경로를 연결한다',
  async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('NETWORK_FORBIDDEN'));
    const db = createDatabase(testDatabaseUrl());
    try {
      await migrateTestDatabase(db);
      const store = createSyntheticOrderReviewStore(db, testDatabaseUrl());
      const source = vi.fn(async () => syntheticOrder());
      const id = randomUUID(),
        scope = contentHash(randomUUID());
      const initial = toOrderObservation(await source(), { scope, observedAt: '2026-11-12T01:00:01.000Z' });
      let checkpoint = await store.initialize({ id, source: 'synthetic-fixture', observation: initial });
      const order = {
        ...syntheticOrder(),
        status: { value: 'PARTIAL_FILLED', known: true },
        execution: {
          quantity: '2',
          averagePrice: '100',
          amount: '200',
          commission: '2',
          tax: '0',
          lastFilledAt: '2026-11-12T01:00:05.000Z',
          settlementDate: null,
        },
      };
      source.mockResolvedValueOnce(order);
      const first = {
        streamId: id,
        source: 'synthetic-fixture',
        operationId: randomUUID(),
        expectedVersion: checkpoint.version,
        expectedObservationHash: checkpoint.observationHash,
        observation: toOrderObservation(await source(), { scope, observedAt: '2026-11-12T01:00:10.000Z' }),
      };
      expect((await store.record(first)).receipt.report?.delta?.quantity).toBe('2');
      expect((await store.record(first)).replayed).toBe(true);
      checkpoint = await store.read(id);
      source.mockResolvedValueOnce({
        ...order,
        execution: { ...order.execution, quantity: '3', amount: '300', commission: '3' },
      });
      const second = await store.record({
        ...first,
        operationId: randomUUID(),
        expectedVersion: checkpoint.version,
        expectedObservationHash: checkpoint.observationHash,
        observation: toOrderObservation(await source(), { scope, observedAt: '2026-11-12T01:00:20.000Z' }),
      });
      expect(second.receipt.report?.delta?.quantity).toBe('1');
      expect((await store.read(id)).eventCount).toBe(2);
      expect(second.receipt.ledgerApplied).toBe(false);
      expect(second.receipt.executionEnabled).toBe(false);
      expect(source).toHaveBeenCalledTimes(3);
      expect(network).not.toHaveBeenCalled();
    } finally {
      await db.close();
      network.mockRestore();
    }
  },
  30000,
);
it.skipIf(!process.env.TEST_DATABASE_URL)(
  'provider의 미체결 null 비용을 worker가 0 기준으로 바꿔 저장하지 않는다',
  async () => {
    const db = createDatabase(testDatabaseUrl());
    try {
      await migrateTestDatabase(db);
      const store = createSyntheticOrderReviewStore(db, testDatabaseUrl()),
        order = syntheticOrder();
      const observation = toOrderObservation(
        { ...order, execution: { ...order.execution, amount: null, commission: null, tax: null } },
        { scope: contentHash(randomUUID()), observedAt: '2026-11-12T01:00:01.000Z' },
      );
      const id = randomUUID();
      await expect(store.initialize({ id, source: 'synthetic-fixture', observation })).rejects.toThrow(
        'ORDER_REVIEW_BASELINE_INVALID',
      );
      await expect(store.read(id)).rejects.toThrow('ORDER_REVIEW_STREAM_MISSING');
    } finally {
      await db.close();
    }
  },
  30000,
);
