import type { Candle, InstrumentId, Money } from '@hth/contracts';
import type { BrokerInstrument, CandleQuery, Holding, ReadonlyBroker } from '@hth/broker';

export async function collectReadonlySnapshot(
  broker: ReadonlyBroker,
  requests: readonly InstrumentId[],
  interval: Candle['interval'],
  maxPages: number,
) {
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 5) throw new Error('INVALID_PAGE_LIMIT');
  const instruments = await broker.getInstruments(requests);
  const quotes = await broker.getQuotes(requests);
  const calendars = [];
  for (const market of [...new Set(requests.map((request) => request.market))])
    calendars.push(await broker.getMarketCalendar(market));
  const exchangeRate = await broker.getExchangeRate('USD', 'KRW');
  const batches: { instrument: BrokerInstrument; candles: Candle[] }[] = [];
  for (const instrument of instruments) {
    const candles = new Map<string, Candle>();
    const cursors = new Set<number>();
    let before: string | undefined;
    for (let page = 0; page < maxPages; page += 1) {
      const query: CandleQuery = {
        instrument: instrument.id,
        interval,
        count: 200,
        adjusted: false,
        ...(before ? { before } : {}),
      };
      const result = await broker.getCandles(query);
      for (const candle of result.candles) candles.set(candle.timestamp, candle);
      if (!result.nextBefore || result.candles.length === 0) break;
      const cursor = Date.parse(result.nextBefore);
      if (!Number.isFinite(cursor) || cursors.has(cursor) || (before && cursor >= Date.parse(before)))
        throw new Error('CANDLE_CURSOR_NOT_ADVANCING');
      cursors.add(cursor);
      before = result.nextBefore;
    }
    batches.push({
      instrument,
      candles: [...candles.values()].sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp)),
    });
  }
  const accounts = await broker.listAccounts();
  let holdingCount = 0;
  const holdings: Holding[] = [];
  const buyingPower: Money[] = [];
  for (const account of accounts.filter((item) => item.type === 'BROKERAGE')) {
    const positions = await broker.getHoldings(account);
    holdingCount += positions.length;
    holdings.push(...positions);
    buyingPower.push(await broker.getBuyingPower(account, 'KRW'));
    buyingPower.push(await broker.getBuyingPower(account, 'USD'));
  }
  return {
    batches,
    holdings,
    buyingPower,
    quotes,
    calendars,
    exchangeRate,
    summary: {
      mode: 'paper',
      executionEnabled: false,
      accounts: accounts.length,
      holdings: holdingCount,
      instruments: instruments.length,
      quotes: quotes.length,
      candles: batches.reduce((total, batch) => total + batch.candles.length, 0),
      markets: calendars.length,
      exchangeRateValidUntil: exchangeRate.validUntil,
      candlesFinalized: false,
    },
  };
}
