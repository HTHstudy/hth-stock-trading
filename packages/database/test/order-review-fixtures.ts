import { randomUUID } from 'node:crypto';
import type { OrderObservation } from '@hth/contracts';
import { contentHash } from '../src/content-hash.js';
export function reviewFixture() {
  const observation: OrderObservation = {
    formatVersion: 'order-observation-v1',
    scope: contentHash(randomUUID()),
    orderReference: 'synthetic-order',
    observedAt: '2026-11-12T01:00:01.000Z',
    instrument: { market: 'US', symbol: 'AAPL' },
    currency: 'USD',
    side: 'BUY',
    definition: {
      type: 'limit',
      validity: 'day',
      quantity: '5',
      limitPrice: '110',
      amount: null,
      orderedAt: '2026-11-12T01:00:00.000Z',
    },
    state: 'pending',
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
  return { id: randomUUID(), source: 'synthetic-fixture' as const, observation };
}
export function partial(
  observation: OrderObservation,
  quantity = '2',
  time = '2026-11-12T01:00:10.000Z',
): OrderObservation {
  return {
    ...structuredClone(observation),
    observedAt: time,
    state: 'partial',
    execution: {
      quantity,
      averagePrice: '100',
      amount: quantity === '3' ? '300' : '200',
      commission: quantity === '3' ? '3' : '2',
      tax: '0',
      lastFilledAt: '2026-11-12T01:00:05.000Z',
      settlementDate: null,
    },
  };
}
