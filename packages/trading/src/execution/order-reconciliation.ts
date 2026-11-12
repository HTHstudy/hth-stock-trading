import { Decimal } from 'decimal.js';
import { orderObservationSchema } from '@hth/contracts';
import type { OrderObservation } from '@hth/contracts';

const Money = Decimal.clone({ precision: 100 });
const terminal = new Set(['filled', 'canceled', 'rejected', 'replaced']);
const safety = {
  ledgerApplied: false,
  canApplyToLedger: false,
  ownershipVerified: false,
  executionEnabled: false,
  canResend: false,
  canResume: false,
} as const;
type Reason =
  | 'INPUT_INVALID'
  | 'BASELINE_REQUIRED'
  | 'IDENTITY_CHANGED'
  | 'DEFINITION_CHANGED'
  | 'OBSERVATION_REVERSED'
  | 'CONFLICTING_OBSERVATION'
  | 'TIMELINE_INVALID'
  | 'QUANTITY_REVERSED'
  | 'AMOUNT_REVERSED'
  | 'TERMINAL_CHANGED'
  | 'STATE_QUANTITY_MISMATCH'
  | 'UNKNOWN_DEFINITION_OR_STATE'
  | 'CHANGE_REJECTION_RECORD'
  | 'AMOUNT_ORDER_UNSUPPORTED'
  | 'TOTALS_UNKNOWN'
  | 'FILL_TIME_UNKNOWN'
  | 'FILL_TIME_REVERSED'
  | 'AMOUNT_NOT_INCREASED'
  | 'AMOUNT_CORRECTION'
  | 'AVERAGE_PRICE_CORRECTION'
  | 'COST_CORRECTION_WITH_FILL';
const amountKeys = ['quantity', 'averagePrice', 'amount', 'commission', 'tax'] as const;
function equalMoney(a: string | null | undefined, b: string | null | undefined) {
  return a == null || b == null ? a === b : new Money(a).eq(b);
}
function sameDefinition(a: OrderObservation, b: OrderObservation) {
  return (
    a.definition.type === b.definition.type &&
    a.definition.validity === b.definition.validity &&
    Date.parse(a.definition.orderedAt) === Date.parse(b.definition.orderedAt) &&
    equalMoney(a.definition.quantity, b.definition.quantity) &&
    equalMoney(a.definition.limitPrice, b.definition.limitPrice) &&
    equalMoney(a.definition.amount, b.definition.amount)
  );
}
function sameTime(a: string | null | undefined, b: string | null | undefined) {
  return a == null || b == null ? a === b : Date.parse(a) === Date.parse(b);
}
function sameContents(a: OrderObservation, b: OrderObservation) {
  return (
    a.state === b.state &&
    sameTime(a.canceledAt, b.canceledAt) &&
    amountKeys.every((key) => equalMoney(a.execution[key], b.execution[key])) &&
    sameTime(a.execution.lastFilledAt, b.execution.lastFilledAt) &&
    a.execution.settlementDate === b.execution.settlementDate
  );
}
/** Compares observations only. It cannot claim account ownership or book a fill. */
export function reconcileOrderObservations(previous: unknown, next: unknown) {
  type Outcome =
    | 'blocked'
    | 'baseline-required'
    | 'unchanged'
    | 'progress'
    | 'cost-adjustment'
    | 'metadata-change'
    | 'review-required';
  const finish = (
    outcome: Outcome,
    reasons: Reason[],
    delta: { quantity: string; amount: string | null; commission: string | null; tax: string | null } | null = null,
  ) => ({
    formatVersion: 'order-reconciliation-v1' as const,
    outcome,
    reasons,
    delta,
    ...safety,
  });
  const b = orderObservationSchema.safeParse(next);
  const a = previous === null ? null : orderObservationSchema.safeParse(previous);
  if (!b.success || (a !== null && !a.success)) return finish('blocked', ['INPUT_INVALID']);
  if (a === null) return finish('baseline-required', ['BASELINE_REQUIRED']);
  if (!a.success) return finish('blocked', ['INPUT_INVALID']);
  const before = a.data,
    after = b.data;
  if (
    before.scope !== after.scope ||
    before.orderReference !== after.orderReference ||
    before.instrument.market !== after.instrument.market ||
    before.instrument.symbol !== after.instrument.symbol ||
    before.currency !== after.currency ||
    before.side !== after.side
  )
    return finish('blocked', ['IDENTITY_CHANGED']);
  if (!sameDefinition(before, after)) return finish('blocked', ['DEFINITION_CHANGED']);
  const timeBefore = Date.parse(before.observedAt),
    timeAfter = Date.parse(after.observedAt);
  if (timeAfter < timeBefore) return finish('blocked', ['OBSERVATION_REVERSED']);
  for (const s of [before, after]) {
    const ordered = Date.parse(s.definition.orderedAt),
      observed = Date.parse(s.observedAt);
    if (
      ordered > observed ||
      [s.canceledAt, s.execution.lastFilledAt].some(
        (t) => t != null && (Date.parse(t) < ordered || Date.parse(t) > observed),
      )
    )
      return finish('blocked', ['TIMELINE_INVALID']);
  }
  if (timeBefore === timeAfter && !sameContents(before, after)) return finish('blocked', ['CONFLICTING_OBSERVATION']);
  const oldQ = new Money(before.execution.quantity),
    newQ = new Money(after.execution.quantity),
    dq = newQ.minus(oldQ);
  if (dq.isNegative()) return finish('blocked', ['QUANTITY_REVERSED']);
  if (
    before.execution.amount !== null &&
    after.execution.amount !== null &&
    new Money(after.execution.amount).lt(before.execution.amount)
  )
    return finish('blocked', ['AMOUNT_REVERSED']);
  if (terminal.has(before.state) && (before.state !== after.state || !dq.isZero()))
    return finish('blocked', ['TERMINAL_CHANGED']);
  if (
    before.execution.lastFilledAt !== null &&
    after.execution.lastFilledAt !== null &&
    Date.parse(after.execution.lastFilledAt) < Date.parse(before.execution.lastFilledAt)
  )
    return finish('blocked', ['FILL_TIME_REVERSED']);
  const review = new Set<Reason>();
  for (const s of [before, after]) {
    if (s.state === 'unknown' || s.definition.type === 'unknown' || s.definition.validity === 'unknown')
      review.add('UNKNOWN_DEFINITION_OR_STATE');
    if (s.state === 'change-rejected') review.add('CHANGE_REJECTION_RECORD');
    const q = new Money(s.execution.quantity),
      size = new Money(s.definition.quantity);
    if (s.definition.amount !== undefined && s.definition.amount !== null) {
      review.add('AMOUNT_ORDER_UNSUPPORTED');
      continue;
    }
    if (
      size.lte(0) ||
      q.gt(size) ||
      (s.state === 'pending' && !q.isZero()) ||
      (s.state === 'partial' && (q.lte(0) || q.gte(size))) ||
      (s.state === 'filled' && !q.eq(size)) ||
      (s.execution.amount !== null &&
        ((q.isZero() && !new Money(s.execution.amount).isZero()) ||
          (!q.isZero() && new Money(s.execution.amount).lte(0)))) ||
      (!q.isZero() && s.execution.averagePrice !== null && new Money(s.execution.averagePrice).lte(0))
    )
      return finish('blocked', ['STATE_QUANTITY_MISMATCH']);
  }
  if (sameContents(before, after))
    return review.size ? finish('review-required', [...review]) : finish('unchanged', []);
  const diff = (key: 'amount' | 'commission' | 'tax') =>
    before.execution[key] === null || after.execution[key] === null
      ? null
      : new Money(after.execution[key]!).minus(before.execution[key]!).toFixed();
  const delta = { quantity: dq.toFixed(), amount: diff('amount'), commission: diff('commission'), tax: diff('tax') };
  if (dq.gt(0)) {
    if (
      [delta.amount, delta.commission, delta.tax].some((v) => v === null) ||
      (before.execution.averagePrice === null && oldQ.gt(0)) ||
      after.execution.averagePrice === null
    )
      review.add('TOTALS_UNKNOWN');
    if (after.execution.lastFilledAt === null || (oldQ.gt(0) && before.execution.lastFilledAt === null))
      review.add('FILL_TIME_UNKNOWN');
    if (delta.amount !== null && new Money(delta.amount).lte(0)) review.add('AMOUNT_NOT_INCREASED');
    if ([delta.commission, delta.tax].some((v) => v !== null && new Money(v).isNegative()))
      review.add('COST_CORRECTION_WITH_FILL');
    return finish(review.size ? 'review-required' : 'progress', [...review], delta);
  }
  if (before.execution.lastFilledAt !== null && after.execution.lastFilledAt === null) review.add('FILL_TIME_UNKNOWN');
  if (!equalMoney(before.execution.amount, after.execution.amount)) review.add('AMOUNT_CORRECTION');
  if (!equalMoney(before.execution.averagePrice, after.execution.averagePrice)) review.add('AVERAGE_PRICE_CORRECTION');
  const costChanged =
    !equalMoney(before.execution.commission, after.execution.commission) ||
    !equalMoney(before.execution.tax, after.execution.tax);
  if (costChanged && (delta.commission === null || delta.tax === null)) review.add('TOTALS_UNKNOWN');
  if (review.size) return finish('review-required', [...review], delta);
  return finish(costChanged ? 'cost-adjustment' : 'metadata-change', [], delta);
}
