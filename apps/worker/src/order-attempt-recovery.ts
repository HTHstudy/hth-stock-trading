import { z } from 'zod';
import { BrokerError } from '@hth/broker';
import type { createTossOrderMockSession } from '@hth/broker/testing';
import type { createOrderAttemptTestStore } from '@hth/database/testing';
import type { OrderAttemptEventData } from '@hth/contracts';
import { toOrderObservation } from './order-observation.js';

type Store = ReturnType<typeof createOrderAttemptTestStore>;
type MockSession = ReturnType<typeof createTossOrderMockSession>;
type Detail = Extract<OrderAttemptEventData, { kind: 'recovery-detail' }>;
const uuid = z.uuid().transform((value) => value.toLowerCase());
const requestSchema = z.strictObject({
  accountId: uuid,
  attemptId: uuid,
  operationId: uuid,
  expectedVersion: z.number().int().min(0).max(512),
  expectedStateHash: z.string().regex(/^[a-f0-9]{64}$/),
});

/** Explicit lookup for a stored acknowledgement, through the mock session only. */
export async function collectMockOrderRecoveryDetail(store: Store, session: MockSession, input: unknown) {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success || session.mode !== 'mock' || session.executionEnabled !== false)
    throw new Error('ORDER_ATTEMPT_RECOVERY_BLOCKED');

  const { accountId, attemptId, ...command } = parsed.data;
  const before = await store.read(accountId);
  const previous = before.journal.find((event) => event.operationId === command.operationId);
  if (previous) {
    const expected = {
      version: previous.sequence - 1,
      stateHash: previous.previousHash,
    };
    if (
      previous.data.kind !== 'recovery-detail' ||
      previous.data.attemptId !== attemptId ||
      command.expectedVersion !== expected.version ||
      command.expectedStateHash !== expected.stateHash
    )
      throw new Error('ORDER_ATTEMPT_OPERATION_CONFLICT');
    return { event: previous, snapshot: before, replayed: true, mockDispatchClaimed: false };
  }
  if (before.version !== command.expectedVersion || before.stateHash !== command.expectedStateHash)
    throw new Error('ORDER_ATTEMPT_STALE');

  const attempt = before.state.attempts.find((item) => item.attemptId === attemptId);
  if (!before.state.paused || attempt?.result?.outcome !== 'acknowledged')
    throw new Error('ORDER_ATTEMPT_RECOVERY_BLOCKED');

  const reference = attempt.result.reference;
  let evidence: Detail['evidence'];
  try {
    const order = await session.readonly.getOrder({ reference: '42', type: 'BROKERAGE' }, reference);
    const observation = toOrderObservation(order, {
      scope: before.context.scopeHash,
      observedAt: new Date().toISOString(),
    });
    evidence = { outcome: 'observed', observation };
  } catch (error) {
    const outcome =
      error instanceof BrokerError && error.status === 404
        ? 'http-404'
        : (error instanceof BrokerError && error.code === 'INVALID_RESPONSE') ||
            (error instanceof Error && error.message === 'ORDER_OBSERVATION_INVALID')
          ? 'invalid-response'
          : 'unavailable';
    evidence = { outcome };
  }
  return store.record(accountId, { ...command, data: { kind: 'recovery-detail', attemptId, reference, evidence } });
}
