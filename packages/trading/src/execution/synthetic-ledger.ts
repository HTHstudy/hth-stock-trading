import { Decimal } from 'decimal.js';
import {
  syntheticLedgerStateSchema,
  syntheticLedgerInitializationSchema,
  syntheticLedgerRegistrationSchema,
  syntheticLedgerApplicationSchema,
  syntheticLedgerEffectSchema,
} from '@hth/contracts';
import type { SyntheticLedgerState, SyntheticLedgerEffect } from '@hth/contracts';
import { reviewSyntheticOrderBinding } from './synthetic-order-binding.js';
import { reconcileOrderObservations } from './order-reconciliation.js';
const Money = Decimal.clone({ precision: 100 });
const safety = {
  ledgerApplied: false,
  ownershipVerified: false,
  evidenceAuthenticated: false,
  canApplyToLedger: false,
  executionEnabled: false,
  canResend: false,
  canResume: false,
} as const;
type Reason =
  | 'INPUT_INVALID'
  | 'STATE_INVALID'
  | 'BINDING_INVALID'
  | 'BASELINE_REQUIRED'
  | 'RESERVATION_INVALID'
  | 'INSUFFICIENT_CASH'
  | 'INSUFFICIENT_OWNERSHIP'
  | 'SEQUENCE_INVALID'
  | 'OBSERVATION_REVIEW_REQUIRED'
  | 'COST_REVIEW_REQUIRED'
  | 'AMOUNT_PRECISION_UNSUPPORTED'
  | 'LIMIT';
export type SyntheticLedgerResult = {
  outcome: 'projected' | 'blocked';
  reason: Reason | null;
  state: SyntheticLedgerState | null;
  effect: SyntheticLedgerEffect | null;
  syntheticProjectionChanged: boolean;
  ledgerApplied: false;
  ownershipVerified: false;
  evidenceAuthenticated: false;
  canApplyToLedger: false;
  executionEnabled: false;
  canResend: false;
  canResume: false;
};
const blocked = (reason: Reason): SyntheticLedgerResult => ({
  outcome: 'blocked',
  reason,
  state: null,
  effect: null,
  syntheticProjectionChanged: false,
  ...safety,
});
const projected = (
  state: SyntheticLedgerState,
  effect: SyntheticLedgerEffect | null = null,
): SyntheticLedgerResult => ({
  outcome: 'projected',
  reason: null,
  state,
  effect,
  syntheticProjectionChanged: true,
  ...safety,
});
const key = (i: { market: string; symbol: string }) => `${i.market}:${i.symbol}`;
const currency = (market: string) => (market === 'KR' ? ('KRW' as const) : ('USD' as const));
const quantized = (v: string, c: 'KRW' | 'USD') => new Money(v).mod(c === 'KRW' ? '1' : '0.01').isZero();
const terminal = new Set(['filled', 'canceled', 'rejected']);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function validate(state: SyntheticLedgerState): Reason | null {
  for (const c of ['KRW', 'USD'] as const)
    if (![state.cash[c], state.receivables[c], state.realizedPnl[c]].every((v) => quantized(v, c)))
      return 'AMOUNT_PRECISION_UNSUPPORTED';
  const positions = new Set<string>(),
    bindings = new Set<string>(),
    intents = new Set<string>(),
    references = new Set<string>(),
    signals = new Set<string>();
  for (const p of state.positions) {
    if (positions.has(key(p.instrument))) return 'STATE_INVALID';
    positions.add(key(p.instrument));
    const owners = new Set<string>();
    for (const o of p.owners) {
      if (
        owners.has(o.strategyId) ||
        !quantized(o.basis, currency(p.instrument.market)) ||
        (new Money(o.quantity).isZero() && !new Money(o.basis).isZero())
      )
        return 'STATE_INVALID';
      owners.add(o.strategyId);
    }
  }
  let applied = 0;
  for (const o of state.orders) {
    const b = o.binding,
      obs = o.observation,
      c = obs.currency;
    if (
      bindings.has(b.bindingId) ||
      intents.has(b.intentId) ||
      references.has(b.orderReference) ||
      signals.has(b.dedupeKey) ||
      !same(b.namespace, state.namespace) ||
      obs.scope !== state.scope ||
      obs.orderReference !== b.orderReference ||
      !new Money(obs.definition.quantity).isInteger() ||
      !new Money(obs.execution.quantity).isInteger() ||
      new Money(obs.execution.quantity).gt(obs.definition.quantity)
    )
      return 'STATE_INVALID';
    if (reconcileOrderObservations(obs, obs).outcome !== 'unchanged') return 'STATE_INVALID';
    bindings.add(b.bindingId);
    intents.add(b.intentId);
    references.add(b.orderReference);
    signals.add(b.dedupeKey);
    applied += o.sequence;
    if (
      obs.execution.amount === null ||
      obs.execution.commission === null ||
      obs.execution.tax === null ||
      ![obs.execution.amount, obs.execution.commission, obs.execution.tax, o.reservedCash].every((v) => quantized(v, c))
    )
      return 'STATE_INVALID';
    if (obs.side === 'BUY' ? !new Money(o.reservedQuantity).isZero() : !new Money(o.reservedCash).isZero())
      return 'RESERVATION_INVALID';
    if (terminal.has(obs.state) && (!new Money(o.reservedCash).isZero() || !new Money(o.reservedQuantity).isZero()))
      return 'RESERVATION_INVALID';
    if (
      obs.side === 'SELL' &&
      !terminal.has(obs.state) &&
      !new Money(o.reservedQuantity).eq(new Money(obs.definition.quantity).minus(obs.execution.quantity))
    )
      return 'RESERVATION_INVALID';
  }
  if (state.version !== state.orders.length + applied || applied > 512) return 'STATE_INVALID';
  for (const c of ['KRW', 'USD'] as const) {
    const reserved = state.orders
      .filter((o) => o.observation.currency === c)
      .reduce((a, o) => a.plus(o.reservedCash), new Money(0));
    if (reserved.gt(state.cash[c])) return 'INSUFFICIENT_CASH';
  }
  for (const o of state.orders.filter((o) => o.observation.side === 'SELL' && new Money(o.reservedQuantity).gt(0))) {
    const position = state.positions.find((p) => key(p.instrument) === key(o.observation.instrument));
    const owner = position?.owners.find((p) => p.strategyId === o.binding.strategy.id);
    const reserved = state.orders
      .filter(
        (other) =>
          other.observation.side === 'SELL' &&
          other.binding.strategy.id === o.binding.strategy.id &&
          key(other.observation.instrument) === key(o.observation.instrument),
      )
      .reduce((a, b) => a.plus(b.reservedQuantity), new Money(0));
    if (!owner || reserved.gt(owner.quantity)) return 'INSUFFICIENT_OWNERSHIP';
  }
  return null;
}
export function initializeSyntheticLedger(input: unknown): SyntheticLedgerResult {
  const p = syntheticLedgerInitializationSchema.safeParse(input);
  if (!p.success) return blocked('INPUT_INVALID');
  const state: SyntheticLedgerState = {
    formatVersion: 'synthetic-ledger-state-v1',
    source: 'synthetic-fixture',
    model: 'native-currency-unsettled-v1',
    namespace: p.data.namespace,
    scope: p.data.scope,
    version: 0,
    cash: p.data.cash,
    receivables: { KRW: '0', USD: '0' },
    realizedPnl: { KRW: '0', USD: '0' },
    positions: p.data.positions.map((v) => ({ ...v, owners: [] })),
    orders: [],
  };
  const reason = validate(state);
  return reason ? blocked(reason) : projected(state);
}
export function registerSyntheticLedgerOrder(input: unknown): SyntheticLedgerResult {
  const p = syntheticLedgerRegistrationSchema.safeParse(input);
  if (!p.success) return blocked('INPUT_INVALID');
  const { state, proof, reservedCash, reservedQuantity } = p.data;
  const invalid = validate(state);
  if (invalid) return blocked(invalid);
  const review = reviewSyntheticOrderBinding(proof),
    b = proof.candidate,
    baseline = proof.observation;
  if (
    !b ||
    !['consistent-synthetic-binding', 'unchanged-synthetic-binding'].includes(review.outcome) ||
    !same(state.namespace, proof.context.namespace) ||
    state.scope !== proof.context.scope
  )
    return blocked('BINDING_INVALID');
  if (
    state.orders.some(
      (o) =>
        o.binding.bindingId === b.bindingId ||
        o.binding.intentId === b.intentId ||
        o.binding.orderReference === b.orderReference ||
        o.binding.dedupeKey === b.dedupeKey,
    )
  )
    return blocked('BINDING_INVALID');
  if (state.orders.length >= 32) return blocked('LIMIT');
  if (
    baseline.state !== 'pending' ||
    !new Money(baseline.execution.quantity).isZero() ||
    [baseline.execution.amount, baseline.execution.commission, baseline.execution.tax].some(
      (v) => v === null || !new Money(v).isZero(),
    ) ||
    baseline.execution.averagePrice !== null ||
    baseline.execution.lastFilledAt !== null ||
    baseline.execution.settlementDate !== null ||
    baseline.canceledAt != null
  )
    return blocked('BASELINE_REQUIRED');
  if (!new Money(baseline.definition.quantity).isInteger()) return blocked('RESERVATION_INVALID');
  const size = new Money(baseline.definition.quantity);
  if (
    baseline.side === 'BUY'
      ? new Money(reservedCash).lte(0) || !new Money(reservedQuantity).isZero()
      : !new Money(reservedCash).isZero() || !new Money(reservedQuantity).eq(size)
  )
    return blocked('RESERVATION_INVALID');
  const next = structuredClone(state);
  next.orders.push({ binding: b, sequence: 0, observation: baseline, reservedCash, reservedQuantity });
  next.version++;
  const reason = validate(next);
  return reason ? blocked(reason) : projected(next);
}
export function applySyntheticLedgerObservation(input: unknown): SyntheticLedgerResult {
  const p = syntheticLedgerApplicationSchema.safeParse(input);
  if (!p.success) return blocked('INPUT_INVALID');
  const { state, bindingId, sequence, observation: next } = p.data;
  const invalid = validate(state);
  if (invalid) return blocked(invalid);
  const index = state.orders.findIndex((o) => o.binding.bindingId === bindingId),
    order = state.orders[index];
  if (!order) return blocked('BINDING_INVALID');
  if (sequence !== order.sequence + 1) return blocked('SEQUENCE_INVALID');
  if (state.version - state.orders.length >= 512) return blocked('LIMIT');
  if (next.state === 'replaced') return blocked('OBSERVATION_REVIEW_REQUIRED');
  const report = reconcileOrderObservations(order.observation, next);
  if (report.outcome === 'cost-adjustment') return blocked('COST_REVIEW_REQUIRED');
  if (!['progress', 'unchanged', 'metadata-change'].includes(report.outcome))
    return blocked('OBSERVATION_REVIEW_REQUIRED');
  const values = [next.execution.amount, next.execution.commission, next.execution.tax];
  if (values.some((v) => v === null || !quantized(v, next.currency)) || !new Money(next.execution.quantity).isInteger())
    return blocked('AMOUNT_PRECISION_UNSUPPORTED');
  const dq = new Money(next.execution.quantity).minus(order.observation.execution.quantity);
  const amount = new Money(next.execution.amount!).minus(order.observation.execution.amount!);
  const commission = new Money(next.execution.commission!).minus(order.observation.execution.commission!);
  const tax = new Money(next.execution.tax!).minus(order.observation.execution.tax!);
  if ([amount, commission, tax].some((v) => v.isNegative())) return blocked('COST_REVIEW_REQUIRED');
  const costs = commission.plus(tax),
    updated = structuredClone(state),
    c = next.currency;
  const current = updated.orders[index]!;
  let position = updated.positions.find((v) => key(v.instrument) === key(next.instrument));
  let owner = position?.owners.find((v) => v.strategyId === order.binding.strategy.id);
  let cashDelta = new Money(0),
    receivableDelta = new Money(0),
    released = new Money(0),
    realized = new Money(0);
  if (dq.gt(0)) {
    if (next.side === 'BUY') {
      const spent = amount.plus(costs);
      if (spent.gt(current.reservedCash)) return blocked('INSUFFICIENT_CASH');
      cashDelta = spent.neg();
      updated.cash[c] = new Money(updated.cash[c]).plus(cashDelta).toFixed();
      current.reservedCash = new Money(current.reservedCash).minus(spent).toFixed();
      if (!position) {
        position = { instrument: next.instrument, manualQuantity: '0', owners: [] };
        updated.positions.push(position);
      }
      if (!owner) {
        owner = { strategyId: order.binding.strategy.id, quantity: '0', basis: '0' };
        position.owners.push(owner);
      }
      owner.quantity = new Money(owner.quantity).plus(dq).toFixed();
      owner.basis = new Money(owner.basis).plus(spent).toFixed();
    } else {
      if (!owner || dq.gt(owner.quantity) || dq.gt(current.reservedQuantity)) return blocked('INSUFFICIENT_OWNERSHIP');
      receivableDelta = amount.minus(costs);
      if (receivableDelta.isNegative()) return blocked('COST_REVIEW_REQUIRED');
      const size = new Money(owner.quantity),
        basis = new Money(owner.basis),
        unit = c === 'KRW' ? '1' : '0.01';
      released = dq.eq(size) ? basis : basis.mul(dq).div(size).div(unit).floor().mul(unit);
      owner.quantity = size.minus(dq).toFixed();
      owner.basis = basis.minus(released).toFixed();
      current.reservedQuantity = new Money(current.reservedQuantity).minus(dq).toFixed();
      updated.receivables[c] = new Money(updated.receivables[c]).plus(receivableDelta).toFixed();
      realized = receivableDelta.minus(released);
      updated.realizedPnl[c] = new Money(updated.realizedPnl[c]).plus(realized).toFixed();
    }
  }
  if (terminal.has(next.state)) {
    current.reservedCash = '0';
    current.reservedQuantity = '0';
  }
  current.observation = next;
  current.sequence = sequence;
  updated.version++;
  const effect = syntheticLedgerEffectSchema.safeParse({
    bindingId,
    sequence,
    currency: c,
    quantity: dq.toFixed(),
    amount: amount.toFixed(),
    commission: commission.toFixed(),
    tax: tax.toFixed(),
    cashDelta: cashDelta.toFixed(),
    receivableDelta: receivableDelta.toFixed(),
    releasedBasis: released.toFixed(),
    realizedPnl: realized.toFixed(),
  });
  const parsed = syntheticLedgerStateSchema.safeParse(updated);
  if (!parsed.success || !effect.success) return blocked('AMOUNT_PRECISION_UNSUPPORTED');
  const reason = validate(parsed.data);
  return reason ? blocked(reason) : projected(parsed.data, effect.data);
}
export function syntheticLedgerStateIssue(input: unknown) {
  const parsed = syntheticLedgerStateSchema.safeParse(input);
  return parsed.success ? validate(parsed.data) : 'INPUT_INVALID';
}
