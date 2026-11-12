import { z } from 'zod';
import { orderObservationSchema } from '@hth/contracts';
import type { createSyntheticOrderReviewStore } from '@hth/database/testing';

type Store = Pick<ReturnType<typeof createSyntheticOrderReviewStore>, 'read' | 'record'>;
const configSchema = z.strictObject({
  source: z.literal('synthetic-fixture'),
  streamId: z.uuid(),
  maxOperations: z.number().int().min(1).max(60),
});
const commandSchema = z.strictObject({
  source: z.literal('synthetic-fixture'),
  streamId: z.uuid(),
  operationId: z.uuid(),
  expectedVersion: z.number().int().min(0).max(2147483646),
  expectedObservationHash: z.string().regex(/^[a-f0-9]{64}$/),
  observation: orderObservationSchema,
});
export type SyntheticOrderReviewCommand = z.infer<typeof commandSchema>;
export type SyntheticOrderReviewSource = {
  next(signal: AbortSignal): Promise<unknown | null>;
  close(): Promise<void>;
};
type Outcome = 'completed' | 'limit-reached' | 'canceled' | 'held' | 'conflict' | 'failed';
type Reason =
  | 'source-exhausted'
  | 'operation-limit'
  | 'canceled'
  | 'review-held'
  | 'conflict'
  | 'checkpoint-read-failed'
  | 'source-read-failed'
  | 'command-invalid'
  | 'record-failed'
  | 'cleanup-failed';

/** Disposable synthetic harness. No broker, account, scheduler or default worker wiring. */
export function createSyntheticOrderReviewSession(store: Store, source: SyntheticOrderReviewSource) {
  let consumed = false;
  return {
    async run(input: unknown, signal: AbortSignal = new AbortController().signal) {
      const config = configSchema.safeParse(input);
      if (!config.success) throw new Error('SYNTHETIC_ORDER_REVIEW_INPUT_INVALID');
      if (consumed) throw new Error('SYNTHETIC_ORDER_REVIEW_SESSION_CONSUMED');
      consumed = true;
      let outcome: Outcome = 'failed';
      let reason: Reason = 'checkpoint-read-failed';
      let attempted = 0,
        committed = 0,
        replayed = 0;
      let checkpointConfirmed = false,
        recordOutcomeUncertain = false,
        cleanupSucceeded = false;
      let phase: Reason = 'checkpoint-read-failed';
      try {
        if (signal.aborted) {
          outcome = 'canceled';
          reason = 'canceled';
        } else {
          let current = await store.read(config.data.streamId);
          checkpointConfirmed = true;
          for (;;) {
            if (signal.aborted) {
              outcome = 'canceled';
              reason = 'canceled';
              break;
            }
            if (current.status === 'quarantined') {
              outcome = 'held';
              reason = 'review-held';
              break;
            }
            if (attempted >= config.data.maxOperations) {
              outcome = 'limit-reached';
              reason = 'operation-limit';
              break;
            }
            phase = 'source-read-failed';
            const raw = await source.next(signal);
            if (signal.aborted) {
              outcome = 'canceled';
              reason = 'canceled';
              break;
            }
            if (raw === null) {
              outcome = 'completed';
              reason = 'source-exhausted';
              break;
            }
            phase = 'command-invalid';
            const command = commandSchema.safeParse(raw);
            if (!command.success || command.data.streamId !== config.data.streamId) {
              reason = 'command-invalid';
              break;
            }
            // Preserve the caller's entire request, including its original CAS and operation ID.
            // Rebuilding it from the latest checkpoint would change an uncertain/replayed request.
            attempted++;
            checkpointConfirmed = false;
            recordOutcomeUncertain = true;
            phase = 'record-failed';
            const result = await store.record(command.data);
            recordOutcomeUncertain = false;
            if (result.replayed) replayed++;
            else committed++;
            phase = 'checkpoint-read-failed';
            current = await store.read(config.data.streamId);
            checkpointConfirmed = true;
            if (result.receipt.outcome === 'conflict') {
              outcome = 'conflict';
              reason = 'conflict';
              break;
            }
            if (current.status === 'quarantined') {
              outcome = 'held';
              reason = 'review-held';
              break;
            }
          }
        }
      } catch {
        outcome = 'failed';
        reason = phase;
      } finally {
        // A pending read/record must settle before closing. Cancellation never undoes a committed receipt.
        try {
          await source.close();
          cleanupSucceeded = true;
        } catch {
          outcome = 'failed';
          reason = 'cleanup-failed';
        }
      }
      return {
        formatVersion: 'synthetic-order-review-session-v1' as const,
        outcome,
        reason,
        attempted,
        committed,
        replayed,
        checkpointConfirmed,
        recordOutcomeUncertain,
        cleanupSucceeded,
        ledgerApplied: false as const,
        canApplyToLedger: false as const,
        ownershipVerified: false as const,
        executionEnabled: false as const,
        canResend: false as const,
        canResume: false as const,
      };
    },
  };
}
