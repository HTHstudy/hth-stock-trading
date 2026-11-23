import { z } from 'zod';
import { orderAttemptAcknowledgedReference } from '@hth/trading';
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
  const reference = orderAttemptAcknowledgedReference(attempt);
  if (!before.state.paused || !reference) throw new Error('ORDER_ATTEMPT_RECOVERY_BLOCKED');

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

const statusRequestSchema = requestSchema.pick({ accountId: true, attemptId: true });

/** Inspect one persisted mock attempt without a broker session or journal mutation. */
export async function readMockOrderRecoveryStatus(store: Store, input: unknown) {
  const parsed = statusRequestSchema.safeParse(input);
  if (!parsed.success) throw new Error('ORDER_ATTEMPT_RECOVERY_BLOCKED');

  const { accountId, attemptId } = parsed.data;
  const snapshot = await store.read(accountId);
  const attempt = snapshot.state.attempts.find((item) => item.attemptId === attemptId);
  if (!attempt) throw new Error('ORDER_ATTEMPT_RECOVERY_BLOCKED');

  const basis = attempt.recoveredAcknowledgement ? 'signed-test-receipt' : (attempt.result?.outcome ?? 'no-result');
  const detail = snapshot.journal.findLast(
    ({ data }) => data.kind === 'recovery-detail' && data.attemptId === attemptId,
  )?.data;
  const review = snapshot.journal.findLast(
    ({ data }) => data.kind === 'recovery-review' && data.attemptId === attemptId,
  )?.data;

  return {
    basis,
    paused: snapshot.state.paused,
    reservationHeld: snapshot.state.resources?.reservation?.intentId === attempt.intentId,
    latestDetail: detail?.kind === 'recovery-detail' ? detail.evidence.outcome : null,
    latestManualReason: review?.kind === 'recovery-review' ? review.reason : null,
    nextStep: !snapshot.state.paused
      ? 'pause-first'
      : orderAttemptAcknowledgedReference(attempt)
        ? 'review-known-order'
        : basis === 'not-sent'
          ? 'review-not-sent'
          : 'provider-correlation-required',
    executionEnabled: false as const,
    canResend: false as const,
    canResume: false as const,
  };
}
