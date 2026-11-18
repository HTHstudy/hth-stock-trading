import type { DurableOrderIntent, DurableOrderResult, OrderAttemptEventData } from '@hth/contracts';
export interface OrderAttemptState {
  paused: boolean;
  epoch: number;
  ownerId: string | null;
  leaseUntil: string | null;
  intents: { intent: DurableOrderIntent; intentHash: string }[];
  attempts: {
    intentId: string;
    attemptId: string;
    intentHash: string;
    ownerId: string;
    epoch: number;
    result: DurableOrderResult | null;
  }[];
}
export function initialOrderAttemptState(): OrderAttemptState {
  return { paused: true, epoch: 0, ownerId: null, leaseUntil: null, intents: [], attempts: [] };
}
function refuse(code: string): never {
  throw new Error(`ORDER_ATTEMPT_${code}`);
}
/** Pure mock control/transport state. It neither reserves real assets nor grants live authority. */
export function evolveOrderAttempt(
  previous: OrderAttemptState,
  data: OrderAttemptEventData,
  at: string,
  intentHash: string | null = null,
): OrderAttemptState {
  const state = structuredClone(previous),
    now = Date.parse(at);
  const active = () => !state.paused && state.ownerId !== null && Date.parse(state.leaseUntil ?? '') > now;
  switch (data.kind) {
    case 'open':
      if (active()) refuse('LEASE_BUSY');
      state.epoch++;
      state.paused = false;
      state.ownerId = data.ownerId;
      state.leaseUntil = new Date(now + 30000).toISOString();
      break;
    case 'pause':
      state.epoch++;
      state.paused = true;
      state.ownerId = null;
      state.leaseUntil = null;
      break;
    case 'heartbeat':
      if (!active() || state.ownerId !== data.ownerId || state.epoch !== data.epoch) refuse('FENCED');
      state.leaseUntil = new Date(now + 30000).toISOString();
      break;
    case 'intent':
      if (state.intents.length >= 64) refuse('LIMIT');
      if (
        state.intents.some(
          ({ intent }) =>
            intent.intentId === data.intent.intentId ||
            intent.signalId === data.intent.signalId ||
            intent.request.clientOrderId === data.intent.request.clientOrderId,
        )
      )
        refuse('INTENT_CONFLICT');
      if (
        !intentHash ||
        Date.parse(data.intent.expiresAt) <= now ||
        Date.parse(data.intent.expiresAt) > now + 15 * 60000
      )
        refuse('INTENT_EXPIRED');
      state.intents.push({ intent: data.intent, intentHash });
      break;
    case 'attempt': {
      if (!active() || state.ownerId !== data.ownerId || state.epoch !== data.epoch) refuse('FENCED');
      const found = state.intents.find(({ intent }) => intent.intentId === data.intentId);
      if (!found || found.intentHash !== data.intentHash) refuse('INTENT_MISMATCH');
      if (Date.parse(found.intent.expiresAt) <= now) refuse('INTENT_EXPIRED');
      if (state.attempts.some((a) => a.intentId === data.intentId || a.attemptId === data.attemptId))
        refuse('ALREADY_CLAIMED');
      // No unresolved/accepted predecessor is bypassed by inventing another client key.
      if (state.attempts.length) refuse('REVIEW_REQUIRED');
      state.attempts.push({
        intentId: data.intentId,
        attemptId: data.attemptId,
        intentHash: data.intentHash,
        ownerId: data.ownerId,
        epoch: data.epoch,
        result: null,
      });
      break;
    }
    case 'result': {
      const found = state.attempts.find((a) => a.attemptId === data.attemptId);
      if (!found || found.result) refuse('RESULT_CONFLICT');
      const original = state.intents.find(({ intent }) => intent.intentId === found.intentId)!;
      if (data.result.clientOrderId !== original.intent.request.clientOrderId || data.result.replayed)
        refuse('RESULT_CONFLICT');
      // Even after pause/lease expiry, retain the response of the original attempt as evidence only.
      found.result = data.result;
      break;
    }
  }
  return state;
}
