import { backtestArtifactSchema, createBacktestReportSchema, instantSchema } from '@hth/contracts';
import { Decimal } from 'decimal.js';
import type { BacktestReport } from './engine.js';

// Covers 400-character report decimals, exact products and calendar-time weights.
const Money = Decimal.clone({ precision: 1000, rounding: Decimal.ROUND_HALF_UP });
// Reuse the report envelope without imposing the public moving-average strategy.
const researchStrategySchema = backtestArtifactSchema.shape.report.shape.strategy
  .omit({ id: true, version: true, parameters: true })
  .loose()
  .refine(
    (value) =>
      typeof value.id === 'string' &&
      value.id.length > 0 &&
      typeof value.version === 'string' &&
      value.version.length > 0 &&
      'parameters' in value,
  );
const reportSchema = createBacktestReportSchema(researchStrategySchema);
function invalid(): never {
  throw new Error('INVALID_CAPITAL_EXPOSURE');
}
function amount(value: unknown, signed = false): Decimal {
  if (typeof value !== 'string' || value.length > 400 || !(signed ? /^-?\d+(\.\d+)?$/ : /^\d+(\.\d+)?$/).test(value))
    invalid();
  return new Money(value);
}
function instant(value: unknown): number {
  if (!instantSchema.safeParse(value).success) invalid();
  const result = Date.parse(value as string);
  if (!Number.isSafeInteger(result)) invalid();
  return result;
}

/** Acquisition cost over calendar time, including nights and closed markets.
 * This is neither market-value exposure nor an annualized or alpha measure.
 */
export function calculateCapitalExposure(report: BacktestReport<unknown>) {
  try {
    if (!reportSchema.safeParse(report).success) invalid();
    if (
      report.formatVersion !== 'backtest-report-v1' ||
      report.mode !== 'paper' ||
      report.executionEnabled !== false ||
      !Array.isArray(report.equity) ||
      !report.equity.length ||
      !Array.isArray(report.fills)
    )
      invalid();
    const first = report.equity[0]!;
    const last = report.equity.at(-1)!;
    const start = instant(first.timestamp);
    const end = instant(last.timestamp);
    const windowMilliseconds = end - start;
    if (
      !Number.isSafeInteger(windowMilliseconds) ||
      windowMilliseconds < 0 ||
      first.kind !== 'initial' ||
      !amount(first.quantity).isZero()
    )
      invalid();
    let previousPoint = start;
    for (const point of report.equity) {
      const at = instant(point.timestamp);
      if (at < previousPoint) invalid();
      amount(point.quantity);
      amount(point.cash);
      amount(point.equity);
      previousPoint = at;
    }
    let quantity = new Money(0);
    let cost = new Money(0);
    let realized = new Money(0);
    let peak = new Money(0);
    let weighted = new Money(0);
    let holdingMilliseconds = 0;
    let previousFill = start;
    let totalBuy = new Money(0);
    let totalSell = new Money(0);
    let fees = new Money(0);
    let taxes = new Money(0);
    let cash = amount(first.cash);
    const initial = amount(report.metrics.initialCash);
    if (
      initial.lte(0) ||
      !initial.eq(amount(report.config.initialCash)) ||
      !cash.eq(initial) ||
      !amount(first.equity).eq(initial)
    )
      invalid();
    const accrue = (at: number) => {
      const duration = at - previousFill;
      weighted = weighted.plus(cost.mul(duration));
      if (quantity.gt(0)) holdingMilliseconds += duration;
      previousFill = at;
    };
    for (const fill of report.fills) {
      const at = instant(fill.timestamp);
      if (at < previousFill || at < start || at > end) invalid();
      const price = amount(fill.price);
      const size = amount(fill.quantity);
      const notional = amount(fill.notional);
      const fee = amount(fill.fee);
      const tax = amount(fill.tax);
      if (price.lte(0) || size.lte(0) || !price.mul(size).eq(notional)) invalid();
      accrue(at);
      if (fill.action === 'BUY') {
        if (!quantity.isZero() || !tax.isZero()) invalid();
        quantity = size;
        cost = notional.plus(fee);
        peak = Money.max(peak, cost);
        totalBuy = totalBuy.plus(notional);
        cash = cash.minus(cost);
      } else if (fill.action === 'SELL') {
        if (quantity.isZero() || !quantity.eq(size)) invalid();
        realized = realized.plus(notional).minus(fee).minus(tax).minus(cost);
        quantity = new Money(0);
        cost = new Money(0);
        totalSell = totalSell.plus(notional);
        cash = cash.plus(notional).minus(fee).minus(tax);
      } else invalid();
      fees = fees.plus(fee);
      taxes = taxes.plus(tax);
      if (!amount(fill.cashAfter).eq(cash)) invalid();
    }
    accrue(end);
    const netPnl = amount(report.metrics.netPnl, true);
    if (
      !quantity.eq(amount(report.metrics.endingQuantity)) ||
      !quantity.eq(amount(last.quantity)) ||
      !cash.eq(amount(report.metrics.endingCash)) ||
      !cash.eq(amount(last.cash)) ||
      !amount(last.equity).eq(amount(report.metrics.endingEquity)) ||
      !amount(last.equity).minus(initial).eq(netPnl) ||
      !realized.eq(amount(report.metrics.realizedPnl, true)) ||
      !amount(last.equity).minus(cash).minus(cost).eq(amount(report.metrics.unrealizedPnl, true)) ||
      !amount(report.metrics.realizedPnl, true).plus(amount(report.metrics.unrealizedPnl, true)).eq(netPnl) ||
      !fees.eq(amount(report.metrics.totalFees)) ||
      !taxes.eq(amount(report.metrics.totalTax)) ||
      report.metrics.fillCount !== report.fills.length
    )
      invalid();
    return {
      model: 'acquisition-cost-calendar-time-v1' as const,
      windowStartAt: new Date(start).toISOString(),
      windowEndAt: new Date(end).toISOString(),
      windowMilliseconds,
      holdingMilliseconds,
      holdingPct:
        windowMilliseconds === 0 ? '0' : new Money(holdingMilliseconds).div(windowMilliseconds).mul(100).toFixed(10),
      maxInvestedCapital: peak.toFixed(),
      averageInvestedCapital: windowMilliseconds === 0 ? '0.0000000000' : weighted.div(windowMilliseconds).toFixed(10),
      netPnlOverMaxInvestedCapitalPct:
        windowMilliseconds === 0 || peak.isZero() ? null : netPnl.div(peak).mul(100).toFixed(10),
      totalBuyNotional: totalBuy.toFixed(),
      totalSellNotional: totalSell.toFixed(),
    };
  } catch {
    return invalid();
  }
}
