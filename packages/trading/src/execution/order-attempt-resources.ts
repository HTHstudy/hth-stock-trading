import { Decimal } from 'decimal.js';
import type { DurableOrderIntent, OrderAttemptContext, OrderAttemptEventData } from '@hth/contracts';
import type { AttemptFillState } from './order-attempt-fills.js';

type Opening = Extract<OrderAttemptEventData, { kind: 'resource-opening' }>['opening'];
type Observation = Extract<OrderAttemptEventData, { kind: 'resource-observe' }>['observation'];
type Currency = keyof Opening['cash'];
const Money = Decimal.clone({ precision: 100 });
const marketKey = ({ instrument }: Opening['manual'][number]) => `${instrument.market}:${instrument.symbol}`;
const managedKey = (position: Opening['managed'][number]) => `${position.strategyId}:${marketKey(position)}`;
const currencyFor = (intent: DurableOrderIntent): Currency =>
  intent.request.instrument.market === 'KR' ? 'KRW' : 'USD';
const fail = (code: string): never => {
  throw new Error(`ORDER_ATTEMPT_${code}`);
};

export interface AttemptResources {
  balances: Opening;
  receivables: Opening['cash'];
  reconciliation: { observation: Observation; differences: string[] } | null;
  reservation: { intentId: string; cashRemaining: string; quantityRemaining: string } | null;
}

export function openAttemptResources(opening: Opening): AttemptResources {
  if (
    new Set(opening.manual.map(marketKey)).size !== opening.manual.length ||
    new Set(opening.managed.map(managedKey)).size !== opening.managed.length
  )
    fail('RESOURCE_INVALID');
  return {
    balances: structuredClone(opening),
    receivables: { KRW: '0', USD: '0' },
    reconciliation: null,
    reservation: null,
  };
}

export function observeAttemptResources(
  resources: AttemptResources,
  observation: Observation,
  context: OrderAttemptContext,
  at: string,
) {
  const time = Date.parse(observation.observedAt);
  const last = resources.reconciliation?.observation;
  if (
    observation.scopeHash !== context.scopeHash ||
    time > Date.parse(at) ||
    (last && time <= Date.parse(last.observedAt))
  )
    fail('RESOURCE_INVALID');

  const totals = new Map<string, Decimal>();
  for (const position of [...resources.balances.manual, ...resources.balances.managed]) {
    const key = marketKey(position);
    totals.set(key, (totals.get(key) ?? new Money(0)).plus(position.quantity));
  }
  const actual = new Map(observation.holdings.map((position) => [marketKey(position), position.quantity]));
  if (actual.size !== observation.holdings.length) fail('RESOURCE_INVALID');
  const differences: string[] = [];
  for (const currency of ['KRW', 'USD'] as const) {
    if (!new Money(observation.cash[currency]).eq(resources.balances.cash[currency])) differences.push(currency);
  }
  for (const key of new Set([...totals.keys(), ...actual.keys()])) {
    if (!(totals.get(key) ?? new Money(0)).eq(actual.get(key) ?? '0')) differences.push(key);
  }
  resources.reconciliation = { observation, differences: differences.sort() };
}

export function requireReconciled(resources: AttemptResources | undefined, at: string) {
  const latest = resources?.reconciliation;
  if (!latest || latest.differences.length) return fail('RESOURCE_UNRECONCILED');
  const age = Date.parse(at) - Date.parse(latest.observation.observedAt);
  if (age < 0 || age > 30_000) fail('RESOURCE_UNRECONCILED');
}

export function reserveAttemptResources(
  resources: AttemptResources,
  intent: DurableOrderIntent,
  cashBudget: string | null,
  at: string,
) {
  requireReconciled(resources, at);
  if (resources.reservation || Date.parse(intent.expiresAt) <= Date.parse(at)) fail('RESOURCE_UNAVAILABLE');
  const { request } = intent;
  const quantity = new Money(request.quantity);
  const buy = request.side === 'BUY';
  if (buy) {
    if (
      cashBudget === null ||
      new Money(cashBudget).lt(quantity.times(request.limitPrice)) ||
      new Money(cashBudget).gt(resources.balances.cash[currencyFor(intent)])
    )
      fail('RESOURCE_UNAVAILABLE');
  } else {
    const owned = resources.balances.managed.find(
      (position) =>
        managedKey(position) ===
        managedKey({ instrument: request.instrument, strategyId: intent.strategyId, quantity: '0' }),
    );
    if (cashBudget !== null || !owned || new Money(owned.quantity).lt(quantity)) fail('RESOURCE_UNAVAILABLE');
  }
  resources.reservation = {
    intentId: intent.intentId,
    cashRemaining: cashBudget ?? '0',
    quantityRemaining: request.quantity,
  };
}

export function bookAttemptResources(
  resources: AttemptResources,
  intent: DurableOrderIntent,
  application: AttemptFillState['applications'][number],
) {
  const reservation = resources.reservation;
  if (!reservation || reservation.intentId !== intent.intentId) return fail('RESOURCE_UNAVAILABLE');
  const quantity = new Money(application.delta.quantity);
  if (quantity.isZero()) return;
  const remaining = new Money(reservation.quantityRemaining).minus(quantity);
  if (remaining.lt(0)) fail('RESOURCE_UNAVAILABLE');
  const cashEffect = new Money(application.cashEffect);
  const currency = currencyFor(intent);
  const { instrument, side, limitPrice } = intent.request;
  const candidate = { instrument, strategyId: intent.strategyId, quantity: '0' };
  const managed = resources.balances.managed;
  const position = managed.find((entry) => managedKey(entry) === managedKey(candidate));
  if (side === 'BUY') {
    const budget = new Money(reservation.cashRemaining).plus(cashEffect);
    const balance = new Money(resources.balances.cash[currency]).plus(cashEffect);
    if (budget.lt(remaining.times(limitPrice)) || balance.lt(0) || (!position && managed.length >= 32))
      fail('RESOURCE_UNAVAILABLE');
    resources.balances.cash[currency] = balance.toFixed();
    reservation.cashRemaining = budget.toFixed();
    if (position) position.quantity = new Money(position.quantity).plus(quantity).toFixed();
    else managed.push({ ...candidate, quantity: quantity.toFixed() });
  } else {
    if (!position || new Money(position.quantity).lt(quantity) || cashEffect.lt(0)) return fail('RESOURCE_UNAVAILABLE');
    position.quantity = new Money(position.quantity).minus(quantity).toFixed();
    resources.receivables[currency] = new Money(resources.receivables[currency]).plus(cashEffect).toFixed();
  }
  reservation.quantityRemaining = remaining.toFixed();
  if (remaining.isZero()) resources.reservation = null;
  // Any economically applied fill invalidates the prior comparison, while preserving its evidence.
  if (resources.reconciliation) resources.reconciliation.differences = ['BALANCES_CHANGED'];
}
