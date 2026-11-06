import { Decimal } from 'decimal.js';
import type { Currency, ExecutionRules, Market } from '@hth/contracts';

const Money = Decimal.clone({ precision: 200 });
const invalid = () => new Error('INVALID_EXECUTION_RULE');
const unsupported = () => new Error('UNSUPPORTED_EXECUTION_RULE_SCOPE');
const decimal = (value: string, maximumLength = 30) => {
  if (!/^\d+(\.\d+)?$/.test(value) || value.length > maximumLength) throw invalid();
  return new Money(value);
};
const unit = (currency: Currency) => new Money(currency === 'KRW' ? '1' : '0.01');

// Deliberately bounded to the researched interval; future rules are not inferred.
export const krxEquityTickEvidence = {
  id: 'krx-kospi-equity-2023',
  effectiveFrom: '2023-01-25',
  modeledThrough: '2026-11-06',
  researchAsOf: '2026-11-06',
  historicalContinuityVerified: false,
  venue: 'KRX',
  board: 'KOSPI',
  assetClass: 'common-stock',
} as const;
const krxBands = [
  ['2000', '1'],
  ['5000', '5'],
  ['20000', '10'],
  ['50000', '50'],
  ['200000', '100'],
  ['500000', '500'],
] as const;
function krxTick(price: Decimal) {
  return new Money(krxBands.find(([ceiling]) => price.lt(ceiling))?.[1] ?? '1000');
}

export function validateExecutionRuleScope(input: {
  rules: ExecutionRules;
  market: Market;
  currency: Currency;
  from: string;
  to: string;
}) {
  const { rules, currency, market, from, to } = input;
  const quantum = unit(currency);
  for (const fee of [rules.buyFee, rules.sellFee]) {
    const minimum = decimal(fee.minimum);
    const maximum = fee.maximum === null ? null : decimal(fee.maximum);
    if (!minimum.mod(quantum).isZero() || (maximum && (!maximum.mod(quantum).isZero() || maximum.lt(minimum))))
      throw invalid();
  }
  if (rules.priceRule === 'krx-kospi-equity-2023') {
    if (
      market !== 'KR' ||
      currency !== 'KRW' ||
      rules.venueAssumption !== 'KRX' ||
      rules.assetClassAssumption !== 'common-stock' ||
      rules.boardAssumption !== 'KOSPI' ||
      from < krxEquityTickEvidence.effectiveFrom ||
      to > krxEquityTickEvidence.modeledThrough
    )
      throw unsupported();
  }
}

export function calculateRulePrice(input: {
  referencePrice: string;
  slippageBps: string;
  priceTick: string;
  side: 'BUY' | 'SELL';
  market: Market;
  currency: Currency;
  tradingDate: string;
  rules: ExecutionRules;
}): string {
  validateExecutionRuleScope({ ...input, from: input.tradingDate, to: input.tradingDate });
  const reference = decimal(input.referencePrice),
    slippage = decimal(input.slippageBps);
  const fixed = decimal(input.priceTick);
  if (reference.lte(0) || slippage.gte(10_000) || fixed.lte(0) || !fixed.mod(unit(input.currency)).isZero())
    throw invalid();
  const buying = input.side === 'BUY';
  const raw = reference.mul(new Money(1).plus(slippage.div(10_000).mul(buying ? 1 : -1)));
  const tick = input.rules.priceRule === 'fixed' ? fixed : krxTick(raw);
  const steps = raw.div(tick);
  const price = (buying ? steps.ceil() : steps.floor()).mul(tick);
  if (input.rules.priceRule !== 'fixed' && !price.mod(krxTick(price)).isZero()) throw invalid();
  return price.toFixed();
}

export function calculateRuleFee(input: {
  notional: string;
  feeBps: string;
  currency: Currency;
  rule: ExecutionRules['buyFee'];
}): string {
  const notional = decimal(input.notional, 100),
    bps = decimal(input.feeBps);
  const minimum = decimal(input.rule.minimum),
    maximum = input.rule.maximum === null ? null : decimal(input.rule.maximum);
  const quantum = unit(input.currency);
  if (
    bps.gte(10_000) ||
    !minimum.mod(quantum).isZero() ||
    (maximum && (!maximum.mod(quantum).isZero() || maximum.lt(minimum)))
  )
    throw invalid();
  if (notional.isZero()) return '0';
  const raw = notional.mul(bps).div(10_000).div(quantum);
  const rounded = (input.rule.rounding === 'ceil' ? raw.ceil() : raw.floor()).mul(quantum);
  const fee = Money.max(rounded, minimum);
  return (maximum === null ? fee : Money.min(fee, maximum)).toFixed();
}
