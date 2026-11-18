import { z } from 'zod';
import { orderAttemptCommandSchema } from '@hth/contracts';
import type { DurableOrderResult } from '@hth/contracts';
import type { createOrderAttemptTestStore } from '@hth/database/testing';
import type { createTossOrderMockSession } from '@hth/broker/testing';
type Store = ReturnType<typeof createOrderAttemptTestStore>;
/** Test composition only. No CLI/default worker wiring; the broker target stays .invalid. */
export async function dispatchOrderAttemptMockOnce(options: {
  store: Store;
  session: ReturnType<typeof createTossOrderMockSession>;
  accountId: string;
  claim: unknown;
  resultOperationId: string;
}) {
  const parsed = orderAttemptCommandSchema.safeParse(options.claim);
  if (
    !parsed.success ||
    parsed.data.data.kind !== 'attempt' ||
    !z.uuid().safeParse(options.resultOperationId).success ||
    !z.uuid().safeParse(options.accountId).success
  )
    throw new Error('ORDER_ATTEMPT_INPUT_INVALID');
  if (
    options.session.mode !== 'mock' ||
    options.session.executionEnabled !== false ||
    options.session.writer.mode !== 'mock' ||
    options.session.writer.executionEnabled !== false
  )
    throw new Error('ORDER_ATTEMPT_MOCK_REQUIRED');
  const claim = parsed.data,
    attempt = parsed.data.data;
  // Commit the immutable attempt before invoking the injected transport, outside the transaction.
  const recorded = await options.store.record(options.accountId, claim);
  if (!recorded.mockDispatchClaimed) return { mockWriterInvoked: false, snapshot: recorded.snapshot };
  const current = await options.store.read(options.accountId);
  if (
    current.state.paused ||
    current.state.ownerId !== attempt.ownerId ||
    current.state.epoch !== attempt.epoch ||
    Date.parse(current.state.leaseUntil ?? '') <= Date.now()
  )
    throw new Error('ORDER_ATTEMPT_FENCED');
  const original = current.state.intents.find(({ intent }) => intent.intentId === attempt.intentId);
  if (!original || original.intentHash !== attempt.intentHash || Date.parse(original.intent.expiresAt) <= Date.now())
    throw new Error('ORDER_ATTEMPT_INTENT_EXPIRED');
  let result: DurableOrderResult;
  try {
    result = await options.session.writer.submitOrder({ reference: '42', type: 'BROKERAGE' }, original.intent.request);
  } catch {
    // A thrown callback does not prove absence of a remote effect. Never generate another attempt.
    result = {
      mode: 'mock',
      executionEnabled: false,
      ownershipVerified: false,
      canApplyToLedger: false,
      canResend: false,
      replayed: false,
      clientOrderId: original.intent.request.clientOrderId,
      outcome: 'unknown',
      code: 'NETWORK_ERROR',
      status: null,
    };
  }
  const after = await options.store.read(options.accountId);
  const saved = await options.store.record(options.accountId, {
    operationId: options.resultOperationId,
    expectedVersion: after.version,
    expectedStateHash: after.stateHash,
    data: { kind: 'result', attemptId: attempt.attemptId, result },
  });
  return { mockWriterInvoked: true, snapshot: saved.snapshot };
}
