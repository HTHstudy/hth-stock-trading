import { Decimal } from 'decimal.js';

export const PaperMoney = Decimal.clone({ precision: 100 });
export function paperFee(notional: Decimal.Value, bps: string, currency: 'KRW' | 'USD') {
  const unit = currency === 'KRW' ? '1' : '0.01';
  return new PaperMoney(notional).mul(bps).div(10_000).div(unit).ceil().mul(unit);
}
export function pendingPaperFee(
  notional: Decimal.Value,
  bps: string,
  currency: 'KRW' | 'USD',
  filledNotional: string,
  paidCosts: string,
) {
  if (!paperFee(filledNotional, bps, currency).eq(paidCosts)) throw new Error('PAPER_COST_MISMATCH');
  return paperFee(new PaperMoney(notional).plus(filledNotional), bps, currency).minus(paidCosts);
}
