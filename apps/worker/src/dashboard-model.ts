import { Decimal } from 'decimal.js';
import { dashboardSnapshotSchema } from '@hth/contracts';
import type { collectReadonlySnapshot } from './readonly-snapshot.js';

const ExactDecimal = Decimal.clone({ precision: 80 });

export function createDashboardSnapshot(
  source: Awaited<ReturnType<typeof collectReadonlySnapshot>>,
  collectedAt: string,
) {
  const holdings = source.holdings.map((holding, index) => {
    const quantity = new ExactDecimal(holding.quantity);
    const cost = quantity.times(holding.averagePurchasePrice);
    const value = quantity.times(holding.lastPrice);
    const pnl = value.minus(cost);
    return {
      key: `${holding.instrument.market}:${holding.instrument.symbol}:${index}`,
      ...holding.instrument,
      name: holding.name,
      currency: holding.currency,
      quantity: holding.quantity,
      averagePurchasePrice: holding.averagePurchasePrice,
      lastPrice: holding.lastPrice,
      value: value.toFixed(),
      cost: cost.toFixed(),
      pnl: pnl.toFixed(),
      pnlPercent: cost.isZero() ? null : pnl.div(cost).times(100).toFixed(4),
    };
  });
  const portfolios = (['KRW', 'USD'] as const).map((currency) => {
    const sum = (field: 'value' | 'cost' | 'pnl') =>
      holdings
        .filter((holding) => holding.currency === currency)
        .reduce((total, holding) => total.plus(holding[field]), new ExactDecimal(0))
        .toFixed();
    return {
      currency,
      value: sum('value'),
      cost: sum('cost'),
      pnl: sum('pnl'),
      buyingPower: source.buyingPower
        .filter((item) => item.currency === currency)
        .reduce((total, item) => total.plus(item.amount), new ExactDecimal(0))
        .toFixed(),
    };
  });
  return dashboardSnapshotSchema.parse({
    dataQuality: source.dataQuality,
    collectedAt,
    accountCount: source.summary.accounts,
    portfolios,
    holdings,
    watchlist: source.batches.map((batch) => {
      const quote = source.quotes.find(
        (item) =>
          item.instrument.market === batch.instrument.id.market &&
          item.instrument.symbol === batch.instrument.id.symbol,
      );
      if (!quote) throw new Error('INVALID_RESPONSE');
      return {
        key: `${batch.instrument.id.market}:${batch.instrument.id.symbol}`,
        ...batch.instrument.id,
        name: batch.instrument.name,
        currency: batch.instrument.currency,
        price: quote.price,
        timestamp: quote.timestamp,
        interval: batch.candles[0]?.interval ?? '1m',
        candles: batch.candles.map(({ timestamp, open, high, low, close, volume }) => ({
          timestamp,
          open,
          high,
          low,
          close,
          volume,
        })),
      };
    }),
    markets: source.calendars.map((calendar) => calendar.today),
    exchangeRate: source.exchangeRate,
  });
}
