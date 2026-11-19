import { Decimal } from 'decimal.js';
import type { DurableOrderIntent, OrderObservation } from '@hth/contracts';
import { reconcileOrderObservations } from './order-reconciliation.js';

const Money = Decimal.clone({ precision: 100 });
const keys = ['quantity', 'amount', 'commission', 'tax'] as const;
type Totals = Record<(typeof keys)[number], string>;
type Review = 'OBSERVATION_CONFLICT' | 'TOTALS_UNKNOWN' | 'UNSUPPORTED_CHANGE';
export interface AttemptFillState {
  observations: { observation: OrderObservation; review: Review | null }[];
  appliedCount: number;
  appliedTotals: Totals;
  applications: { observationSequence: number; delta: Totals; cashEffect: string }[];
}
const fail = (code: string): never => {
  throw new Error(`ORDER_ATTEMPT_${code}`);
};

export function observeAttemptFill(
  fills: AttemptFillState | undefined,
  intent: DurableOrderIntent,
  reference: string,
  scope: string | undefined,
  observation: OrderObservation,
  recordedAt: string,
  claimedAt: string,
  allowFinal = false,
): AttemptFillState {
  const { request } = intent;
  const { definition, instrument, execution } = observation;
  if (
    observation.scope !== scope ||
    observation.orderReference !== reference ||
    instrument.market !== request.instrument.market ||
    instrument.symbol !== request.instrument.symbol ||
    observation.side !== request.side ||
    definition.type !== 'limit' ||
    definition.validity !== 'day' ||
    definition.amount != null ||
    !new Money(definition.quantity).eq(request.quantity) ||
    definition.limitPrice == null ||
    !new Money(definition.limitPrice).eq(request.limitPrice) ||
    Date.parse(definition.orderedAt) < Date.parse(claimedAt) ||
    Date.parse(observation.observedAt) > Date.parse(recordedAt)
  )
    fail('FILL_MISMATCH');

  const state = fills ?? {
    observations: [],
    appliedCount: 0,
    appliedTotals: { ...intent.internalOpening },
    applications: [],
  };
  const prior = state.observations.at(-1)?.observation;
  // A first provider observation is validated against itself for timeline and state consistency.
  // The internal zero baseline never enters the provider reconciliation stream.
  const reconciliation = reconcileOrderObservations(prior ?? observation, observation);
  const quantity = new Money(execution.quantity);
  const missingEvidence =
    reconciliation.outcome === 'review-required' &&
    reconciliation.reasons.every((reason) => reason === 'TOTALS_UNKNOWN' || reason === 'FILL_TIME_UNKNOWN');
  const supportedState = allowFinal
    ? ['canceled', 'expired'].includes(observation.state) && quantity.lt(request.quantity)
    : ['pending', 'partial', 'filled'].includes(observation.state) && observation.canceledAt == null;
  let review: Review | null = null;
  if (reconciliation.outcome === 'blocked') {
    review = 'OBSERVATION_CONFLICT';
  } else if (
    !supportedState ||
    !quantity.isInteger() ||
    (!['unchanged', 'progress', 'metadata-change'].includes(reconciliation.outcome) && !missingEvidence)
  ) {
    review = 'UNSUPPORTED_CHANGE';
  } else if (
    keys.some((key) => execution[key] === null) ||
    (quantity.gt(0) && (execution.averagePrice === null || execution.lastFilledAt === null))
  ) {
    review = 'TOTALS_UNKNOWN';
  }
  state.observations.push({ observation, review });
  return state;
}

export function applyAttemptFill(
  state: AttemptFillState | undefined,
  intent: DurableOrderIntent,
  sequence: number,
): AttemptFillState {
  const entry = state?.observations[sequence - 1];
  if (!state || !entry || sequence !== state.appliedCount + 1) return fail('FILL_SEQUENCE');
  if (entry.review) fail('FILL_REVIEW_REQUIRED');

  const totals = { ...state.appliedTotals };
  const delta = { ...totals };
  for (const key of keys) {
    const total = entry.observation.execution[key];
    if (total === null) return fail('FILL_REVIEW_REQUIRED');
    totals[key] = new Money(total).toFixed();
    delta[key] = new Money(total).minus(state.appliedTotals[key]).toFixed();
  }
  const quantity = new Money(delta.quantity);
  const amount = new Money(delta.amount);
  const costs = new Money(delta.commission).plus(delta.tax);
  const limitAmount = quantity.times(intent.request.limitPrice);
  const buy = intent.request.side === 'BUY';
  if (
    keys.some((key) => new Money(delta[key]).lt(0)) ||
    (quantity.isZero() && keys.some((key) => !new Money(delta[key]).isZero())) ||
    (quantity.gt(0) && (amount.lte(0) || (buy ? amount.gt(limitAmount) : amount.lt(limitAmount))))
  )
    fail('FILL_REVIEW_REQUIRED');
  state.appliedTotals = totals;
  state.appliedCount = sequence;
  state.applications.push({
    observationSequence: sequence,
    delta,
    cashEffect: (buy ? amount.plus(costs).negated() : amount.minus(costs)).toFixed(),
  });
  return state;
}
