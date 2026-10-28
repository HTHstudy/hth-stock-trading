import type { PaperRiskSnapshot } from '@hth/contracts';
import { PaperMoney as Money, pendingPaperFee } from './paper-money.js';

export function paperPortfolios(snapshot: PaperRiskSnapshot) {
  return (['KRW', 'USD'] as const).map((currency) => {
    const market = currency === 'KRW' ? 'KR' : 'US';
    const reserved = snapshot.reservations
      .filter((item) => item.instrument.market === market && item.side === 'BUY')
      .reduce((sum, item) => {
        const notional = new Money(item.remainingQuantity).mul(item.limitPrice);
        return sum
          .plus(notional)
          .plus(pendingPaperFee(notional, item.costBps, currency, item.filledNotional, item.paidCosts));
      }, new Money(0));
    const holdings = snapshot.positions
      .filter((item) => item.instrument.market === market)
      .reduce((sum, item) => sum.plus(new Money(item.quantity).mul(item.markPrice)), new Money(0));
    return {
      currency,
      cash: snapshot.cash[currency],
      reservedCash: reserved.toFixed(),
      availableCash: new Money(snapshot.cash[currency]).minus(reserved).toFixed(),
      holdingsValue: holdings.toFixed(),
      equity: holdings.plus(snapshot.cash[currency]).toFixed(),
      dailyPnl: snapshot.dailyPnl[currency].netPnl,
      tradingDate: snapshot.dailyPnl[currency].tradingDate,
    };
  });
}
export function paperPositionValue(quantity: string, price: string) {
  return new Money(quantity).mul(price).toFixed();
}
