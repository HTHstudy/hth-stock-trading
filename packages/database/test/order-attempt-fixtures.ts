import { randomUUID } from 'node:crypto';
import type { DurableOrderIntent, OrderAttemptContext, OrderAttemptEventData } from '@hth/contracts';
export function orderAttemptFixture() {
  const context: OrderAttemptContext = {
    source: 'mock-wire-v1',
    accountId: randomUUID(),
    brokerId: 'toss',
    scopeHash: 'a'.repeat(64),
  };
  const intent: DurableOrderIntent = {
    intentId: randomUUID(),
    signalId: randomUUID(),
    strategyId: randomUUID(),
    strategyRevision: 1,
    request: {
      profile: 'limit-day-integer-v1',
      clientOrderId: randomUUID(),
      instrument: { market: 'KR', symbol: '005930' },
      side: 'BUY',
      quantity: '5',
      limitPrice: '70000',
    },
    expiresAt: new Date(Date.now() + 10 * 60000).toISOString(),
    internalOpening: { quantity: '0', amount: '0', commission: '0', tax: '0' },
  };
  return { context, intent, ownerId: randomUUID(), attemptId: randomUUID() };
}
export function attemptCommand(snapshot: { version: number; stateHash: string }, data: OrderAttemptEventData) {
  return { operationId: randomUUID(), expectedVersion: snapshot.version, expectedStateHash: snapshot.stateHash, data };
}
