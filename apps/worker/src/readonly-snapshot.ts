import type { Candle, InstrumentId, MarketCalendar, Money } from '@hth/contracts';
import { marketDataQualitySchema } from '@hth/contracts';
import { marketDataPolicy, prepareStrategyData } from '@hth/trading';
import type { BrokerInstrument, CandleQuery, Holding, ReadonlyBroker } from '@hth/broker';

export async function collectReadonlySnapshot(
  broker: ReadonlyBroker,
  requests: readonly InstrumentId[],
  interval: Candle['interval'],
  maxPages: number,
  now: () => number = Date.now,
) {
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 5) throw new Error('INVALID_PAGE_LIMIT');
  const instruments = await broker.getInstruments(requests);
  const quotesObservedAt = new Date(now()).toISOString();
  const quotes = await broker.getQuotes(requests);
  const calendars: MarketCalendar[] = [];
  const calendarsObservedAt = new Map<string, string>();
  for (const market of [...new Set(requests.map((request) => request.market))]) {
    calendarsObservedAt.set(market, new Date(now()).toISOString());
    calendars.push(await broker.getMarketCalendar(market));
  }
  const exchangeRate = await broker.getExchangeRate('USD', 'KRW');
  const batches: { instrument: BrokerInstrument; candles: Candle[]; observedAt: string }[] = [];
  for (const instrument of instruments) {
    const observedAt = new Date(now()).toISOString();
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
      observedAt,
      candles: [...candles.values()].sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp)),
    });
  }
  const accountObservedAt = new Date(now()).toISOString();
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
  const checkedAt = new Date(now()).toISOString();
  const quality = batches.map((batch) => {
    const instrument = batch.instrument;
    const assessment = prepareStrategyData({
      instrument: instrument.id,
      nxtSupported: instrument.nxtSupported,
      restricted:
        instrument.status !== 'ACTIVE' ||
        (instrument.id.market === 'KR' &&
          (instrument.krxTradingSuspended !== false ||
            instrument.nxtSupported === null ||
            (instrument.nxtSupported && instrument.nxtTradingSuspended !== false))),
      candles: batch.candles,
      candlesObservedAt: batch.observedAt,
      quoteTimestamp:
        quotes.find(
          (quote) =>
            quote.instrument.market === instrument.id.market && quote.instrument.symbol === instrument.id.symbol,
        )?.timestamp ?? null,
      quoteObservedAt: quotesObservedAt,
      accountObservedAt,
      accountAvailable: accounts.some((account) => account.type === 'BROKERAGE') && buyingPower.length >= 2,
      calendar: calendars.find((calendar) => calendar.today.market === instrument.id.market) ?? null,
      calendarObservedAt: calendarsObservedAt.get(instrument.id.market) ?? null,
      exchangeRate,
      asOf: checkedAt,
    });
    batch.candles = assessment.assessments.map((item) => item.candle);
    return {
      key: `${instrument.id.market}:${instrument.id.symbol}`,
      ready: assessment.ready,
      validUntil: assessment.validUntil,
      closedCandles: assessment.assessments.filter((item) => item.status === 'closed').length,
      pendingCandles: assessment.assessments.filter((item) => item.status === 'pending').length,
      blockedCandles: assessment.assessments.filter((item) => item.status === 'blocked').length,
      strategyCandles: assessment.candles.length,
      blockers: assessment.blockers,
    };
  });
  const dataQuality = marketDataQualitySchema.parse({
    policyVersion: marketDataPolicy.version,
    checkedAt,
    readyCount: quality.filter((item) => item.ready).length,
    instruments: quality,
  });
  return {
    dataQuality,
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
      candleRevisionsPossible: true,
      closedCandles: quality.reduce((total, item) => total + item.closedCandles, 0),
      strategyDataReady: dataQuality.readyCount,
    },
  };
}
