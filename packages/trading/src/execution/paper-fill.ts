import { paperLedgerStateSchema, paperOrderCandidateSchema, paperRiskSnapshotSchema } from '@hth/contracts';
import type { PaperOrderCandidate, PaperRiskSnapshot, PaperLedgerState } from '@hth/contracts';
import { marketDate } from '../market-data/policy.js';
import { PaperMoney as Money, paperFee, pendingPaperFee } from './paper-money.js';

export interface PaperCostBasis {
  quantity: string;
  amount: string;
}
export interface PaperFillInput {
  snapshot: PaperRiskSnapshot;
  candidate: PaperOrderCandidate;
  quantity: string;
  quote: { price: string; timestamp: string; observedAt: string };
  cumulative: { quantity: string; notional: string; costs: string };
  basis: PaperCostBasis | null;
  asOf: string;
  maxDailyLoss: string;
}
const key = (instrument: PaperOrderCandidate['instrument']) => `${instrument.market}:${instrument.symbol}`;

export function settlePaperFill(input: PaperFillInput) {
  const snapshot = paperRiskSnapshotSchema.parse(input.snapshot);
  const order = paperOrderCandidateSchema.parse(input.candidate);
  const reserve = snapshot.reservations.find((entry) => entry.intentId === order.intentId);
  if (
    !reserve ||
    snapshot.accountId !== order.accountId ||
    !snapshot.reconciled ||
    reserve.strategyId !== order.strategyId ||
    reserve.side !== order.side ||
    key(reserve.instrument) !== key(order.instrument) ||
    new Money(reserve.limitPrice).lt(order.limitPrice)
  )
    throw new Error('PAPER_RESERVATION_MISMATCH');
  const currency = order.instrument.market === 'KR' ? 'KRW' : 'USD';
  const unit = currency === 'KRW' ? '1' : '0.01';
  const quantity = new Money(input.quantity);
  const previousQuantity = new Money(input.cumulative.quantity);
  if (
    !quantity.isInteger() ||
    !previousQuantity.isInteger() ||
    previousQuantity.lt(0) ||
    quantity.lte(0) ||
    quantity.gt(reserve.remainingQuantity) ||
    !previousQuantity.plus(reserve.remainingQuantity).eq(order.quantity) ||
    !new Money(input.cumulative.notional).eq(reserve.filledNotional) ||
    !new Money(input.cumulative.costs).eq(reserve.paidCosts)
  )
    throw new Error('PAPER_FILL_QUANTITY_INVALID');
  const rawPrice = new Money(input.quote.price).div(unit);
  const price = (order.side === 'BUY' ? rawPrice.ceil() : rawPrice.floor()).mul(unit);
  if (price.lte(0)) throw new Error('PAPER_FILL_PRICE_INVALID');
  if (order.side === 'BUY' ? price.gt(order.limitPrice) : price.lt(order.limitPrice)) return null;
  const notional = quantity.mul(price);
  const filledQuantity = previousQuantity.plus(quantity);
  const filledNotional = new Money(input.cumulative.notional).plus(notional);
  const paidCosts = paperFee(filledNotional, reserve.costBps, currency);
  const costs = paidCosts.minus(input.cumulative.costs);
  const remaining = new Money(order.quantity).minus(filledQuantity);
  const remainingNotional = remaining.mul(reserve.limitPrice);
  const pendingCosts = pendingPaperFee(
    remainingNotional,
    reserve.costBps,
    currency,
    filledNotional.toFixed(),
    paidCosts.toFixed(),
  );
  const remainingCash = order.side === 'BUY' ? remainingNotional.plus(pendingCosts) : new Money(0);
  const ledger: PaperLedgerState = structuredClone(paperLedgerStateSchema.strip().parse(snapshot));
  const existing = ledger.positions.find((entry) => key(entry.instrument) === key(order.instrument));
  if (new Set(ledger.positions.map((position) => key(position.instrument))).size !== ledger.positions.length)
    throw new Error('PAPER_OWNERSHIP_MISMATCH');
  for (const position of ledger.positions) {
    const owned = position.ownership.reduce(
      (sum, owner) => sum.plus(owner.quantity),
      new Money(position.manualQuantity),
    );
    if (
      !owned.eq(position.quantity) ||
      !owned.isInteger() ||
      [position.manualQuantity, position.sellableQuantity, ...position.ownership.map((entry) => entry.quantity)].some(
        (amount) => !new Money(amount).isInteger(),
      ) ||
      new Set(position.ownership.map((owner) => owner.strategyId)).size !== position.ownership.length ||
      new Money(position.sellableQuantity).gt(position.quantity)
    )
      throw new Error('PAPER_OWNERSHIP_MISMATCH');
  }
  const owner = existing?.ownership.find((entry) => entry.strategyId === order.strategyId);
  const ownQuantity = new Money(owner?.quantity ?? '0');
  if (
    (input.basis === null && !ownQuantity.isZero()) ||
    (input.basis !== null &&
      (!ownQuantity.eq(input.basis.quantity) ||
        new Money(input.basis.amount).lt(0) ||
        (ownQuantity.isZero() && !new Money(input.basis.amount).isZero()) ||
        !new Money(input.basis.amount).mod(unit).isZero()))
  )
    throw new Error('PAPER_BASIS_MISMATCH');
  let basisAmount = new Money(input.basis?.amount ?? '0');
  let realizedPnl = new Money(0);
  const otherReservations = snapshot.reservations.filter((entry) => entry.intentId !== order.intentId);
  const otherCash = otherReservations
    .filter((entry) => entry.side === 'BUY' && entry.instrument.market === order.instrument.market)
    .reduce((sum, entry) => {
      const amount = new Money(entry.remainingQuantity).mul(entry.limitPrice);
      return sum
        .plus(amount)
        .plus(pendingPaperFee(amount, entry.costBps, currency, entry.filledNotional, entry.paidCosts));
    }, new Money(0));
  if (order.side === 'BUY') {
    const spent = notional.plus(costs);
    const oldAmount = new Money(reserve.remainingQuantity).mul(reserve.limitPrice);
    const budget = oldAmount.plus(
      pendingPaperFee(oldAmount, reserve.costBps, currency, reserve.filledNotional, reserve.paidCosts),
    );
    if (spent.plus(remainingCash).gt(budget)) throw new Error('PAPER_RESERVATION_MISMATCH');
    ledger.cash[currency] = new Money(ledger.cash[currency]).minus(spent).toFixed();
    basisAmount = basisAmount.plus(spent);
    const position = existing ?? {
      instrument: order.instrument,
      quantity: '0',
      manualQuantity: '0',
      sellableQuantity: '0',
      ownership: [],
      markPrice: price.toFixed(),
      markTimestamp: input.quote.timestamp,
      markObservedAt: input.quote.observedAt,
    };
    position.quantity = new Money(position.quantity).plus(quantity).toFixed();
    position.sellableQuantity = new Money(position.sellableQuantity).plus(quantity).toFixed();
    if (owner) owner.quantity = ownQuantity.plus(quantity).toFixed();
    else position.ownership.push({ strategyId: order.strategyId, quantity: quantity.toFixed() });
    if (!existing) ledger.positions.push(position);
  } else {
    const pending = otherReservations.filter(
      (entry) => entry.side === 'SELL' && key(entry.instrument) === key(order.instrument),
    );
    const allReserved = pending.reduce((sum, entry) => sum.plus(entry.remainingQuantity), new Money(0));
    const ownReserved = pending
      .filter((entry) => entry.strategyId === order.strategyId)
      .reduce((sum, entry) => sum.plus(entry.remainingQuantity), new Money(0));
    if (
      !existing ||
      !owner ||
      quantity.plus(remaining).plus(ownReserved).gt(ownQuantity) ||
      quantity.plus(remaining).plus(allReserved).gt(existing.sellableQuantity)
    )
      throw new Error('PAPER_INSUFFICIENT_OWNED_QUANTITY');
    const released = quantity.eq(ownQuantity)
      ? basisAmount
      : basisAmount.mul(quantity).div(ownQuantity).div(unit).floor().mul(unit);
    basisAmount = basisAmount.minus(released);
    const proceeds = notional.minus(costs);
    realizedPnl = proceeds.minus(released);
    ledger.cash[currency] = new Money(ledger.cash[currency]).plus(proceeds).toFixed();
    existing.quantity = new Money(existing.quantity).minus(quantity).toFixed();
    existing.sellableQuantity = new Money(existing.sellableQuantity).minus(quantity).toFixed();
    owner.quantity = ownQuantity.minus(quantity).toFixed();
    existing.ownership = existing.ownership.filter((entry) => new Money(entry.quantity).gt(0));
    ledger.positions = ledger.positions.filter((entry) => new Money(entry.quantity).gt(0));
  }
  if (new Money(ledger.cash[currency]).lt(otherCash.plus(remainingCash))) throw new Error('PAPER_INSUFFICIENT_CASH');
  const marked = ledger.positions.find((entry) => key(entry.instrument) === key(order.instrument));
  if (marked)
    Object.assign(marked, {
      markPrice: price.toFixed(),
      markTimestamp: input.quote.timestamp,
      markObservedAt: input.quote.observedAt,
    });
  const equity = (state: Pick<PaperLedgerState, 'cash' | 'positions'>) =>
    state.positions
      .filter((entry) => entry.instrument.market === order.instrument.market)
      .reduce(
        (sum, entry) => sum.plus(new Money(entry.quantity).mul(entry.markPrice)),
        new Money(state.cash[currency]),
      );
  const day = ledger.dailyPnl[currency];
  if (day.tradingDate !== marketDate(Date.parse(input.asOf), order.instrument.market))
    throw new Error('PAPER_DAILY_PNL_DATE_MISMATCH');
  const netPnl = new Money(day.netPnl).plus(equity(ledger).minus(equity(snapshot)));
  const otherCosts = otherReservations
    .filter((entry) => entry.instrument.market === order.instrument.market)
    .reduce(
      (sum, entry) =>
        sum.plus(
          pendingPaperFee(
            new Money(entry.remainingQuantity).mul(entry.limitPrice),
            entry.costBps,
            currency,
            entry.filledNotional,
            entry.paidCosts,
          ),
        ),
      new Money(0),
    );
  if (
    new Money(day.netPnl).lte(new Money(input.maxDailyLoss).negated()) ||
    netPnl.minus(otherCosts).minus(pendingCosts).lte(new Money(input.maxDailyLoss).negated())
  )
    throw new Error('PAPER_DAILY_LOSS_LIMIT');
  day.netPnl = netPnl.toFixed();
  ledger.observedAt = input.asOf;
  const nextOwner = ledger.positions
    .find((entry) => key(entry.instrument) === key(order.instrument))
    ?.ownership.find((entry) => entry.strategyId === order.strategyId);
  return {
    ledger: paperLedgerStateSchema.parse(ledger),
    price: price.toFixed(),
    quantity: quantity.toFixed(),
    notional: notional.toFixed(),
    costs: costs.toFixed(),
    realizedPnl: realizedPnl.toFixed(),
    filledQuantity: filledQuantity.toFixed(),
    filledNotional: filledNotional.toFixed(),
    paidCosts: paidCosts.toFixed(),
    remainingQuantity: remaining.toFixed(),
    remainingCash: remainingCash.toFixed(),
    remainingSell: order.side === 'SELL' ? remaining.toFixed() : '0',
    basis: { quantity: nextOwner?.quantity ?? '0', amount: basisAmount.toFixed() },
  };
}
