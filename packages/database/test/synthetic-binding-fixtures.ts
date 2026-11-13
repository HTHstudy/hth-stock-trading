import { randomUUID } from 'node:crypto';
import type { SyntheticOrderBindingInput } from '@hth/contracts';
import { contentHash } from '../src/content-hash.js';
export function syntheticBindingFixture(): SyntheticOrderBindingInput {
  const namespace = { accountId: randomUUID(), brokerId: 'fake-broker', environment: 'synthetic-fixture' as const };
  const strategy = { id: 'fake-strategy', revision: 1, definitionHash: contentHash('fake-strategy') };
  const intentId = randomUUID(),
    attemptId = randomUUID(),
    orderReference = `fake-order-${randomUUID()}`;
  const scope = contentHash(randomUUID()),
    dedupeKey = contentHash(randomUUID());
  const request: NonNullable<SyntheticOrderBindingInput['intent']>['request'] = {
    instrument: { market: 'US', symbol: 'AAPL' },
    currency: 'USD',
    side: 'BUY',
    definition: { type: 'limit', validity: 'day', quantity: '5', limitPrice: '110', amount: null },
  };
  const requestHash = contentHash(request);
  return {
    formatVersion: 'synthetic-order-binding-input-v1',
    source: 'synthetic-fixture',
    context: { namespace: { ...namespace }, scope, connectionGeneration: 1 },
    candidate: {
      bindingId: randomUUID(),
      namespace: { ...namespace },
      intentId,
      strategy: { ...strategy },
      requestHash,
      dedupeKey,
      orderReference,
    },
    intent: {
      namespace: { ...namespace },
      intentId,
      strategy: { ...strategy },
      requestHash,
      dedupeKey,
      recordedAt: '2026-11-12T01:00:00.000Z',
      request,
    },
    attempt: {
      namespace: { ...namespace },
      attemptId,
      intentId,
      requestHash,
      originGeneration: 1,
      recordedAt: '2026-11-12T01:00:01.000Z',
    },
    acknowledgement: {
      kind: 'synthetic-acceptance',
      namespace: { ...namespace },
      attemptId,
      intentId,
      requestHash,
      originGeneration: 1,
      orderReference,
      receivedAt: '2026-11-12T01:00:03.000Z',
    },
    observationNamespace: { ...namespace },
    observation: {
      formatVersion: 'order-observation-v1',
      scope,
      orderReference,
      observedAt: '2026-11-12T01:00:04.000Z',
      instrument: { ...request.instrument },
      currency: request.currency,
      side: request.side,
      definition: { ...request.definition, orderedAt: '2026-11-12T01:00:02.000Z' },
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
  };
}
export function syntheticBindingEvidence(input: SyntheticOrderBindingInput) {
  return {
    formatVersion: input.formatVersion,
    source: input.source,
    context: input.context,
    candidate: input.candidate,
    attempt: input.attempt,
    acknowledgement: input.acknowledgement,
    observationNamespace: input.observationNamespace,
    observation: input.observation,
  };
}
