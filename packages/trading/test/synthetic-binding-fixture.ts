import type { SyntheticOrderBindingInput } from '@hth/contracts';
export const syntheticBindingUuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
export function syntheticBindingFixture(): SyntheticOrderBindingInput {
  const namespace = {
    brokerId: 'fake-broker',
    environment: 'synthetic-fixture' as const,
    accountId: syntheticBindingUuid(1),
  };
  const strategy = { id: 'fake-strategy', revision: 3, definitionHash: 'b'.repeat(64) };
  return structuredClone({
    formatVersion: 'synthetic-order-binding-input-v1',
    source: 'synthetic-fixture',
    context: { namespace: { ...namespace }, scope: 'a'.repeat(64), connectionGeneration: 1 },
    candidate: {
      bindingId: syntheticBindingUuid(2),
      namespace: { ...namespace },
      intentId: syntheticBindingUuid(3),
      strategy: { ...strategy },
      requestHash: 'c'.repeat(64),
      dedupeKey: 'd'.repeat(64),
      orderReference: 'fake-order',
    },
    intent: {
      namespace: { ...namespace },
      intentId: syntheticBindingUuid(3),
      strategy: { ...strategy },
      requestHash: 'c'.repeat(64),
      dedupeKey: 'd'.repeat(64),
      recordedAt: '2026-11-12T01:00:00.000Z',
      request: {
        instrument: { market: 'US', symbol: 'AAPL' },
        currency: 'USD',
        side: 'BUY',
        definition: { type: 'limit', validity: 'day', quantity: '5', limitPrice: '110', amount: null },
      },
    },
    attempt: {
      namespace: { ...namespace },
      attemptId: syntheticBindingUuid(4),
      intentId: syntheticBindingUuid(3),
      requestHash: 'c'.repeat(64),
      originGeneration: 1,
      recordedAt: '2026-11-12T01:00:01.000Z',
    },
    acknowledgement: {
      kind: 'synthetic-acceptance',
      namespace: { ...namespace },
      attemptId: syntheticBindingUuid(4),
      intentId: syntheticBindingUuid(3),
      requestHash: 'c'.repeat(64),
      originGeneration: 1,
      orderReference: 'fake-order',
      receivedAt: '2026-11-12T01:00:03.000Z',
    },
    observationNamespace: { ...namespace },
    observation: {
      formatVersion: 'order-observation-v1',
      scope: 'a'.repeat(64),
      orderReference: 'fake-order',
      observedAt: '2026-11-12T01:00:04.000Z',
      instrument: { market: 'US', symbol: 'AAPL' },
      currency: 'USD',
      side: 'BUY',
      definition: {
        type: 'limit',
        validity: 'day',
        quantity: '5',
        limitPrice: '110',
        amount: null,
        orderedAt: '2026-11-12T01:00:02.000Z',
      },
      state: 'pending',
      execution: {
        quantity: '0',
        amount: null,
        commission: null,
        tax: null,
        averagePrice: null,
        lastFilledAt: null,
        settlementDate: null,
      },
    },
    registry: { complete: true, bindings: [] },
  });
}
