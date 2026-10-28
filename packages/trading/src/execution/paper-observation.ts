import { paperLedgerStateSchema, paperObservationSchema } from '@hth/contracts';
import { PaperMoney as Money } from './paper-money.js';
import { marketDate, marketDataPolicy, observationBlocker } from '../market-data/policy.js';

export function observePaperLedger(state: unknown, value: unknown, asOf: string) {
  const ledger = paperLedgerStateSchema.parse(state);
  const observation = paperObservationSchema.parse(value);
  const key = (instrument: { market: string; symbol: string }) => `${instrument.market}:${instrument.symbol}`;
  const marks = new Map(observation.quotes.map((quote) => [key(quote.instrument), quote]));
  if (marks.size !== observation.quotes.length || marks.size !== ledger.positions.length)
    throw new Error('PAPER_MARKS_MISMATCH');
  const positions = ledger.positions.map((position) => {
    const quote = marks.get(key(position.instrument));
    if (!quote) throw new Error('PAPER_MARKS_MISMATCH');
    if (
      observationBlocker(quote.timestamp, asOf, marketDataPolicy.quoteMaxAgeMs, 'QUOTE_STALE') ||
      observationBlocker(quote.observedAt, asOf, marketDataPolicy.quoteMaxAgeMs, 'QUOTE_STALE') ||
      (position.markTimestamp !== null && Date.parse(quote.timestamp!) < Date.parse(position.markTimestamp)) ||
      Date.parse(quote.observedAt) < Date.parse(position.markObservedAt)
    )
      throw new Error('PAPER_OBSERVATION_STALE');
    return { ...position, markPrice: quote.price, markTimestamp: quote.timestamp, markObservedAt: quote.observedAt };
  });
  const dailyPnl = structuredClone(ledger.dailyPnl);
  for (const market of ['KR', 'US'] as const) {
    const currency = market === 'KR' ? 'KRW' : 'USD';
    const day = marketDate(Date.parse(asOf), market);
    const previousDay = marketDate(Date.parse(ledger.observedAt), market);
    const previous = ledger.dailyPnl[currency];
    const rolling = previous.tradingDate !== day;
    if (
      previous.tradingDate !== previousDay ||
      (rolling && observationBlocker(ledger.observedAt, asOf, marketDataPolicy.accountMaxAgeMs, 'ACCOUNT_STALE'))
    )
      throw new Error('PAPER_TRADING_DAY_REVIEW_REQUIRED');
    const equity = (items: typeof positions) =>
      items
        .filter((position) => position.instrument.market === market)
        .reduce(
          (sum, position) => sum.plus(new Money(position.quantity).mul(position.markPrice)),
          new Money(ledger.cash[currency]),
        );
    dailyPnl[currency] = {
      tradingDate: day,
      netPnl: new Money(rolling ? '0' : previous.netPnl)
        .plus(equity(positions).minus(equity(ledger.positions)))
        .toFixed(),
    };
  }
  return paperLedgerStateSchema.parse({ ...ledger, positions, dailyPnl, observedAt: asOf, reconciled: true });
}
