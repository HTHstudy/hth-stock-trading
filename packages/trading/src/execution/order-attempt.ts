import type {
  DurableOrderIntent,
  DurableOrderResult,
  OrderAttemptContext,
  OrderAttemptEventData,
} from '@hth/contracts';
import { observeAttemptFill, applyAttemptFill } from './order-attempt-fills.js';
import type { AttemptFillState } from './order-attempt-fills.js';
import {
  openAttemptResources,
  observeAttemptResources,
  requireReconciled,
  reserveAttemptResources,
  bookAttemptResources,
  releaseAttemptResources,
} from './order-attempt-resources.js';
import type { AttemptResources } from './order-attempt-resources.js';
export interface OrderAttemptState {
  resources?: AttemptResources;
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
    recoveredAcknowledgement?: { reference: string; proofId: string };
    claimedAt: string;
    fills?: AttemptFillState;
    final?: { reason: 'canceled' | 'expired'; sequence: number; recordedAt: string };
  }[];
}
export function orderAttemptAcknowledgedReference(attempt: OrderAttemptState['attempts'][number] | undefined) {
  if (attempt?.result?.outcome === 'acknowledged') return attempt.result.reference;
  return attempt?.recoveredAcknowledgement?.reference;
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
  context?: OrderAttemptContext,
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
      if (context?.source === 'mock-resource-v1') {
        if (!state.resources || state.resources.reservation?.intentId !== data.intentId)
          return refuse('RESOURCE_UNAVAILABLE');
        requireReconciled(state.resources, at);
      }
      // No unresolved/accepted predecessor is bypassed by inventing another client key.
      if (state.attempts.length) refuse('REVIEW_REQUIRED');
      state.attempts.push({
        intentId: data.intentId,
        attemptId: data.attemptId,
        intentHash: data.intentHash,
        ownerId: data.ownerId,
        epoch: data.epoch,
        result: null,
        claimedAt: at,
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

    case 'observe-fill':
    case 'resource-final':
    case 'apply-fill': {
      const attempt = state.attempts.find((item) => item.attemptId === data.attemptId);
      const reference = orderAttemptAcknowledgedReference(attempt);
      if (!attempt || !reference) refuse('FILL_UNBOUND');
      const original = state.intents.find(({ intent }) => intent.intentId === attempt.intentId)!;
      if (data.kind === 'observe-fill' || data.kind === 'resource-final') {
        if (attempt.final) refuse('RESOURCE_FINAL_INVALID');
        if (data.kind === 'resource-final') {
          const { observation } = data;
          const reason = observation.state;
          const closed = Date.parse(data.closedAt);
          if (
            context?.source !== 'mock-resource-v1' ||
            state.resources?.reservation?.intentId !== attempt.intentId ||
            (reason !== 'canceled' && reason !== 'expired') ||
            closed < Date.parse(observation.definition.orderedAt) ||
            closed > Date.parse(observation.observedAt) ||
            (observation.execution.lastFilledAt && Date.parse(observation.execution.lastFilledAt) > closed) ||
            (reason === 'canceled'
              ? !observation.canceledAt || Date.parse(observation.canceledAt) !== closed
              : observation.canceledAt != null)
          )
            return refuse('RESOURCE_FINAL_INVALID');
          attempt.final = { reason, sequence: (attempt.fills?.observations.length ?? 0) + 1, recordedAt: at };
          const reconciliation = state.resources.reconciliation;
          if (reconciliation && !reconciliation.differences.length) reconciliation.differences = ['FINAL_OBSERVED'];
        }
        attempt.fills = observeAttemptFill(
          attempt.fills,
          original.intent,
          reference,
          context?.scopeHash,
          data.observation,
          at,
          attempt.claimedAt,
          data.kind === 'resource-final',
        );
      } else {
        attempt.fills = applyAttemptFill(attempt.fills, original.intent, data.observationSequence);
        if (state.resources) {
          bookAttemptResources(
            state.resources,
            original.intent,
            attempt.fills.applications.at(-1)!,
            data.observationSequence === attempt.final?.sequence,
          );
        }
      }
      break;
    }
    case 'resource-opening':
      if (context?.source !== 'mock-resource-v1' || !state.paused || state.resources || state.attempts.length)
        return refuse('RESOURCE_INVALID');
      state.resources = openAttemptResources(data.opening);
      break;
    case 'resource-observe':
      if (context?.source !== 'mock-resource-v1' || !state.resources) return refuse('RESOURCE_INVALID');
      observeAttemptResources(state.resources, data.observation, context, at);
      break;
    case 'resource-reserve': {
      const original = state.intents.find(({ intent }) => intent.intentId === data.intentId);
      if (context?.source !== 'mock-resource-v1' || !state.resources || !original || state.attempts.length)
        return refuse('RESOURCE_UNAVAILABLE');
      reserveAttemptResources(state.resources, original.intent, data.cashBudget, at);
      break;
    }
    case 'resource-release': {
      const resources = state.resources;
      const original = state.intents.find(({ intent }) => intent.intentId === data.intentId);
      const attempt = state.attempts.find((item) => item.intentId === data.intentId);
      if (context?.source !== 'mock-resource-v1' || !state.paused || !resources || !original)
        return refuse('RESOURCE_RELEASE_BLOCKED');
      switch (data.reason) {
        case 'local-canceled':
        case 'intent-expired':
          if (attempt || (data.reason === 'intent-expired' && Date.parse(original.intent.expiresAt) > now))
            refuse('RESOURCE_RELEASE_BLOCKED');
          break;
        case 'not-sent':
          if (attempt?.result?.outcome !== 'not-sent') refuse('RESOURCE_RELEASE_BLOCKED');
          break;
        case 'canceled':
        case 'expired':
          if (
            attempt?.final?.reason !== data.reason ||
            attempt.fills?.appliedCount !== attempt.final.sequence ||
            Date.parse(resources.reconciliation?.observation.observedAt ?? '') < Date.parse(attempt.final.recordedAt)
          )
            return refuse('RESOURCE_RELEASE_BLOCKED');
          requireReconciled(resources, at);
          break;
      }
      releaseAttemptResources(resources, data.intentId, data.reason, at);
      break;
    }

    case 'recovery-review':
    case 'recovery-detail': {
      const attempt = state.attempts.find((item) => item.attemptId === data.attemptId);
      if (!context || !state.paused || !attempt || attempt.result?.outcome === 'not-sent')
        return refuse('RECOVERY_BLOCKED');
      const reference = orderAttemptAcknowledgedReference(attempt);
      if (data.kind === 'recovery-review') {
        const known = reference !== undefined;
        if (known !== (data.reason === 'detail-inconclusive')) refuse('RECOVERY_BLOCKED');
        break;
      }
      if (reference !== data.reference) return refuse('RECOVERY_BLOCKED');
      if (data.evidence.outcome === 'observed') {
        const { observation } = data.evidence;
        if (
          observation.scope !== context.scopeHash ||
          observation.orderReference !== data.reference ||
          Date.parse(observation.observedAt) > now ||
          Date.parse(observation.observedAt) < Date.parse(attempt.claimedAt)
        )
          refuse('RECOVERY_BLOCKED');
      }
      // Recovery evidence is in the journal. The financial projection is unchanged.
      break;
    }

    case 'recovery-ack': {
      const { receipt } = data;
      const attempt = state.attempts.find((item) => item.attemptId === receipt.attemptId);
      const original = state.intents.find(({ intent }) => intent.intentId === attempt?.intentId);
      if (
        context?.source !== 'mock-resource-v1' ||
        !context.recoveryPublicKey ||
        !state.paused ||
        !attempt ||
        attempt.result?.outcome !== 'unknown' ||
        attempt.recoveredAcknowledgement ||
        !original ||
        attempt.intentHash !== receipt.intentHash ||
        original.intent.request.clientOrderId !== receipt.clientOrderId ||
        context.accountId !== receipt.accountId ||
        context.scopeHash !== receipt.scopeHash ||
        Date.parse(receipt.capturedAt) < Date.parse(attempt.claimedAt) ||
        Date.parse(receipt.capturedAt) > now
      )
        return refuse('RECOVERY_BLOCKED');
      // Authentication and journal linkage are checked by the test store before reduction.
      attempt.recoveredAcknowledgement = { reference: receipt.reference, proofId: receipt.proofId };
      break;
    }
  }
  return state;
}
