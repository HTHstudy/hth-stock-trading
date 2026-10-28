import { Decimal } from 'decimal.js';
import { instantSchema, paperControlSchema, paperOrderCandidateSchema, paperRiskInputSchema } from '@hth/contracts';
import type { PaperOrderCandidate, PaperRiskInput, PaperRiskSnapshot, RiskBlocker } from '@hth/contracts';
import type { DataBlocker } from '../market-data/policy.js';
import { marketDataPolicy, marketDate, observationBlocker } from '../market-data/policy.js';
import { prepareStrategyData } from '../market-data/readiness.js';

const Money = Decimal.clone({ precision: 100 });
const key = (instrument: PaperOrderCandidate['instrument']) => `${instrument.market}:${instrument.symbol}`;
const currencyOf = (instrument: PaperOrderCandidate['instrument']) =>
  instrument.market === 'KR' ? ('KRW' as const) : ('USD' as const);
const total = (values: readonly Decimal[]) => values.reduce((sum, value) => sum.plus(value), new Money(0));
const charge = (notional: Decimal, bps: string, currency: 'KRW' | 'USD') => {
  const unit = currency === 'KRW' ? '1' : '0.01';
  return notional.mul(bps).div(10_000).div(unit).ceil().mul(unit);
};

export interface RiskDecision {
  policyVersion: 'paper-risk-v1';
  mode: 'paper';
  executionEnabled: false;
  canReserve: boolean;
  blockers: RiskBlocker[];
  dataBlockers: DataBlocker[];
  checkedAt: string | null;
  validUntil: string | null;
  controlEpoch: number | null;
  snapshotVersion: number | null;
  accountId: string | null;
  reservation: {
    intentId: string;
    strategyId: string;
    instrument: PaperOrderCandidate['instrument'];
    side: 'BUY' | 'SELL';
    quantity: string;
    limitPrice: string;
    cashAmount: string;
    sellQuantity: string;
    notional: string;
    costs: string;
  } | null;
}

export function evaluatePaperRisk(value: unknown): RiskDecision {
  const result: RiskDecision = {
    policyVersion: 'paper-risk-v1',
    mode: 'paper',
    executionEnabled: false,
    canReserve: false,
    blockers: [],
    dataBlockers: [],
    checkedAt: null,
    validUntil: null,
    controlEpoch: null,
    snapshotVersion: null,
    accountId: null,
    reservation: null,
  };
  const parsed = paperRiskInputSchema.safeParse(value);
  if (!parsed.success) return { ...result, blockers: ['INVALID_INPUT'] };
  const input = parsed.data;
  const { candidate, limits, control, snapshot } = input;
  result.checkedAt = input.asOf;
  result.controlEpoch = control?.epoch ?? null;
  result.snapshotVersion = snapshot?.version ?? null;
  result.accountId = candidate.accountId;
  const blockers = new Set<RiskBlocker>();
  if (!limits) blockers.add('LIMITS_NOT_CONFIGURED');
  if (!control) blockers.add('CONTROL_UNAVAILABLE');
  else if (control.stopped) blockers.add('EMERGENCY_STOP');
  if (control && control.epoch === Number.MAX_SAFE_INTEGER - 1) blockers.add('CONTROL_UNAVAILABLE');
  if (!snapshot) blockers.add('SNAPSHOT_UNAVAILABLE');
  else if (snapshot.accountId !== candidate.accountId) blockers.add('ACCOUNT_MISMATCH');
  if (!input.runtime.workerOwned) blockers.add('WORKER_NOT_OWNED');
  if (!input.runtime.sourcesHealthy) blockers.add('SOURCE_UNHEALTHY');
  if (input.runtime.hasUnknownOrders) blockers.add('UNKNOWN_ORDERS');
  if (!input.runtime.strategyEnabled) blockers.add('STRATEGY_DISABLED');
  if (!input.runtime.dedupeClear) blockers.add('DUPLICATE_INTENT');
  if (key(input.quote.instrument) !== key(candidate.instrument)) blockers.add('DATA_NOT_READY');
  const data = prepareStrategyData({
    ...input.marketData,
    instrument: candidate.instrument,
    quoteTimestamp: input.quote.timestamp,
    quoteObservedAt: input.quote.observedAt,
    accountObservedAt: snapshot?.observedAt ?? input.asOf,
    accountAvailable: Boolean(snapshot?.reconciled && snapshot.accountId === candidate.accountId),
    asOf: input.asOf,
  });
  result.dataBlockers = data.blockers;
  if (!data.ready) blockers.add('DATA_NOT_READY');
  if (!limits || !snapshot || !control) return { ...result, blockers: [...blockers] };
  const currency = currencyOf(candidate.instrument);
  const policy = limits[currency];
  const unit = currency === 'KRW' ? '1' : '0.01';
  for (const money of ['KRW', 'USD'] as const) {
    const step = money === 'KRW' ? '1' : '0.01';
    if (
      [limits[money].maxOrderAmount, limits[money].maxInstrumentAmount, limits[money].maxDailyLoss].some(
        (amount) => !new Money(amount).mod(step).isZero(),
      )
    )
      blockers.add('INVALID_LIMITS');
    if (!new Money(snapshot.cash[money]).mod(step).isZero()) blockers.add('INVALID_LEDGER');
  }
  if (!new Money(candidate.limitPrice).mod(unit).isZero()) blockers.add('INVALID_INPUT');
  const positions = new Map<string, PaperRiskSnapshot['positions'][number]>();
  for (const position of snapshot.positions) {
    if (positions.has(key(position.instrument))) blockers.add('INVALID_LEDGER');
    positions.set(key(position.instrument), position);
    if (
      new Set(position.ownership.map((owner) => owner.strategyId)).size !== position.ownership.length ||
      new Money(position.sellableQuantity).gt(position.quantity)
    )
      blockers.add('OWNERSHIP_MISMATCH');
    const owned = total(position.ownership.map((owner) => new Money(owner.quantity))).plus(position.manualQuantity);
    if (!owned.eq(position.quantity)) blockers.add('OWNERSHIP_MISMATCH');
    if (
      currencyOf(position.instrument) === currency &&
      (position.markTimestamp === null ||
        observationBlocker(position.markObservedAt, input.asOf, marketDataPolicy.quoteMaxAgeMs, 'QUOTE_STALE') ||
        observationBlocker(position.markTimestamp, input.asOf, marketDataPolicy.quoteMaxAgeMs, 'QUOTE_STALE'))
    )
      blockers.add('POSITION_MARK_STALE');
  }
  const ids = new Set<string>();
  const reservedCash = { KRW: new Money(0), USD: new Money(0) };
  const reservedCosts = { KRW: new Money(0), USD: new Money(0) };
  const reservedSells = new Map<string, Decimal>();
  for (const reservation of snapshot.reservations) {
    if (ids.has(reservation.intentId)) blockers.add('RESERVATION_MISMATCH');
    ids.add(reservation.intentId);
    if (reservation.intentId === candidate.intentId) blockers.add('DUPLICATE_INTENT');
    const marketKey = key(reservation.instrument);
    const reserveCurrency = currencyOf(reservation.instrument);
    const amount = new Money(reservation.limitPrice).mul(reservation.remainingQuantity);
    reservedCosts[reserveCurrency] = reservedCosts[reserveCurrency].plus(
      charge(amount, reservation.costBps, reserveCurrency),
    );
    if (
      !new Money(reservation.remainingQuantity).isInteger() ||
      !new Money(reservation.limitPrice).mod(reserveCurrency === 'KRW' ? '1' : '0.01').isZero()
    )
      blockers.add('RESERVATION_MISMATCH');
    if (reservation.side === 'BUY') {
      const notional = new Money(reservation.limitPrice).mul(reservation.remainingQuantity);
      reservedCash[reserveCurrency] = reservedCash[reserveCurrency]
        .plus(notional)
        .plus(charge(notional, reservation.costBps, reserveCurrency));
    } else {
      const ownerKey = `${marketKey}|${reservation.strategyId}`;
      reservedSells.set(ownerKey, (reservedSells.get(ownerKey) ?? new Money(0)).plus(reservation.remainingQuantity));
    }
  }
  for (const money of ['KRW', 'USD'] as const)
    if (reservedCash[money].gt(snapshot.cash[money])) blockers.add('RESERVATION_MISMATCH');
  for (const position of snapshot.positions) {
    let allReserved = new Money(0);
    for (const owner of position.ownership) {
      const reserved = reservedSells.get(`${key(position.instrument)}|${owner.strategyId}`) ?? new Money(0);
      if (reserved.gt(owner.quantity)) blockers.add('RESERVATION_MISMATCH');
      allReserved = allReserved.plus(reserved);
    }
    if (allReserved.gt(position.sellableQuantity)) blockers.add('RESERVATION_MISMATCH');
  }
  for (const reservation of snapshot.reservations.filter((entry) => entry.side === 'SELL')) {
    if (
      !positions
        .get(key(reservation.instrument))
        ?.ownership.some((owner) => owner.strategyId === reservation.strategyId)
    )
      blockers.add('RESERVATION_MISMATCH');
  }
  const day = snapshot.dailyPnl[currency];
  if (day.tradingDate !== marketDate(Date.parse(input.asOf), candidate.instrument.market))
    blockers.add('DAILY_PNL_DATE_MISMATCH');
  if (new Money(day.netPnl).lte(new Money(policy.maxDailyLoss).negated())) blockers.add('DAILY_LOSS_LIMIT');
  const quantity = new Money(candidate.quantity);
  const price = Money.max(candidate.limitPrice, input.quote.price);
  const notional = price.mul(quantity);
  const costs = charge(notional, candidate.side === 'BUY' ? policy.buyCostBps : policy.sellCostBps, currency);
  if (new Money(day.netPnl).minus(reservedCosts[currency]).minus(costs).lte(new Money(policy.maxDailyLoss).negated()))
    blockers.add('DAILY_LOSS_LIMIT');
  if (notional.plus(costs).gt(policy.maxOrderAmount)) blockers.add('ORDER_AMOUNT_LIMIT');
  const position = positions.get(key(candidate.instrument));
  const relevant = snapshot.reservations.filter(
    (reservation) => key(reservation.instrument) === key(candidate.instrument),
  );
  if (candidate.side === 'BUY') {
    if (position || relevant.some((reservation) => reservation.side === 'BUY')) blockers.add('DUPLICATE_BUY');
    if (relevant.some((reservation) => reservation.side === 'SELL')) blockers.add('OPEN_ORDER_CONFLICT');
    const exposure = position
      ? new Money(position.quantity).mul(Money.max(position.markPrice, input.quote.price))
      : new Money(0);
    const pending = total(
      relevant
        .filter((reservation) => reservation.side === 'BUY')
        .map((reservation) => {
          const amount = new Money(reservation.remainingQuantity).mul(
            Money.max(reservation.limitPrice, input.quote.price),
          );
          return amount.plus(charge(amount, reservation.costBps, currency));
        }),
    );
    if (exposure.plus(pending).plus(notional).plus(costs).gt(policy.maxInstrumentAmount))
      blockers.add('INSTRUMENT_AMOUNT_LIMIT');
    const symbols = new Set([
      ...positions.keys(),
      ...snapshot.reservations
        .filter((reservation) => reservation.side === 'BUY')
        .map((reservation) => key(reservation.instrument)),
    ]);
    symbols.add(key(candidate.instrument));
    if (symbols.size > limits.maxPositions) blockers.add('MAX_POSITIONS');
    if (notional.plus(costs).gt(new Money(snapshot.cash[currency]).minus(reservedCash[currency])))
      blockers.add('INSUFFICIENT_CASH');
  } else {
    if (relevant.some((reservation) => reservation.side === 'BUY')) blockers.add('OPEN_ORDER_CONFLICT');
    const owned = new Money(
      position?.ownership.find((owner) => owner.strategyId === candidate.strategyId)?.quantity ?? '0',
    );
    const ownReserved = total(
      relevant
        .filter((reservation) => reservation.side === 'SELL' && reservation.strategyId === candidate.strategyId)
        .map((reservation) => new Money(reservation.remainingQuantity)),
    );
    const allReserved = total(
      relevant
        .filter((reservation) => reservation.side === 'SELL')
        .map((reservation) => new Money(reservation.remainingQuantity)),
    );
    if (
      quantity.gt(Money.min(owned.minus(ownReserved), new Money(position?.sellableQuantity ?? '0').minus(allReserved)))
    )
      blockers.add('INSUFFICIENT_OWNED_QUANTITY');
  }
  if (blockers.size) return { ...result, blockers: [...blockers] };
  const markExpiry = snapshot.positions
    .filter((entry) => currencyOf(entry.instrument) === currency)
    .flatMap((entry) => [
      Date.parse(entry.markObservedAt) + marketDataPolicy.quoteMaxAgeMs,
      Date.parse(entry.markTimestamp!) + marketDataPolicy.quoteMaxAgeMs,
    ]);
  const validUntil = new Date(Math.min(Date.parse(data.validUntil!), ...markExpiry)).toISOString();
  return {
    ...result,
    canReserve: true,
    validUntil,
    reservation: {
      intentId: candidate.intentId,
      strategyId: candidate.strategyId,
      instrument: candidate.instrument,
      side: candidate.side,
      quantity: candidate.quantity,
      limitPrice: candidate.limitPrice,
      cashAmount: candidate.side === 'BUY' ? notional.plus(costs).toFixed() : '0',
      sellQuantity: candidate.side === 'SELL' ? candidate.quantity : '0',
      notional: notional.toFixed(),
      costs: costs.toFixed(),
    },
  };
}

export function isPaperRiskCurrent(
  decision: RiskDecision,
  input: {
    asOf: string;
    control: unknown;
    snapshotVersion: number;
    candidate: unknown;
    runtime: PaperRiskInput['runtime'];
  },
) {
  const control = paperControlSchema.safeParse(input.control);
  const runtime = paperRiskInputSchema.shape.runtime.safeParse(input.runtime);
  const candidate = paperOrderCandidateSchema.safeParse(input.candidate);
  const now = Date.parse(input.asOf);
  return Boolean(
    decision.policyVersion === 'paper-risk-v1' &&
    decision.mode === 'paper' &&
    decision.executionEnabled === false &&
    decision.canReserve &&
    decision.reservation &&
    decision.blockers.length === 0 &&
    decision.dataBlockers.length === 0 &&
    decision.checkedAt &&
    decision.validUntil &&
    instantSchema.safeParse(input.asOf).success &&
    now >= Date.parse(decision.checkedAt) &&
    now < Date.parse(decision.validUntil) &&
    control.success &&
    !control.data.stopped &&
    control.data.epoch < Number.MAX_SAFE_INTEGER - 1 &&
    control.data.epoch === decision.controlEpoch &&
    input.snapshotVersion === decision.snapshotVersion &&
    candidate.success &&
    candidate.data.accountId === decision.accountId &&
    candidate.data.intentId === decision.reservation.intentId &&
    candidate.data.strategyId === decision.reservation.strategyId &&
    candidate.data.side === decision.reservation.side &&
    candidate.data.quantity === decision.reservation.quantity &&
    candidate.data.limitPrice === decision.reservation.limitPrice &&
    key(candidate.data.instrument) === key(decision.reservation.instrument) &&
    runtime.success &&
    runtime.data.workerOwned &&
    runtime.data.sourcesHealthy &&
    !runtime.data.hasUnknownOrders &&
    runtime.data.strategyEnabled &&
    runtime.data.dedupeClear,
  );
}
