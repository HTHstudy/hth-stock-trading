import { z } from 'zod';
import { paperEvidenceSchema, paperOrderCandidateSchema } from '@hth/contracts';
import type { PaperEvidence } from '@hth/contracts';
import type { ReadonlyBroker } from '@hth/broker';
import { collectCandles } from './collect-candles.js';
import type { PaperSource } from './paper-worker.js';

// No account, buying-power, holding or order capabilities cross this boundary.
type MarketBroker = Pick<
  ReadonlyBroker,
  'getInstruments' | 'getQuotes' | 'getCandles' | 'getMarketCalendar' | 'getExchangeRate'
>;
const requestsSchema = z.array(paperOrderCandidateSchema.shape.instrument).min(1).max(20);
const key = (instrument: { market: string; symbol: string }) => `${instrument.market}:${instrument.symbol}`;

export function createPaperMarketSource(broker: MarketBroker, maxPages = 1, now: () => number = Date.now): PaperSource {
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 5) throw new Error('INVALID_PAGE_LIMIT');
  let busy = false;
  return async (input, signal): Promise<PaperEvidence[]> => {
    signal.throwIfAborted();
    if (busy) throw new Error('PAPER_MARKET_SOURCE_BUSY');
    const requests = requestsSchema.parse(input);
    const keys = new Set(requests.map(key));
    if (keys.size !== requests.length) throw new Error('PAPER_SOURCE_INSTRUMENT_MISMATCH');
    busy = true;
    // The broker owns bounded transport timeouts. Abort prevents further reads and
    // discards an in-flight result; its current HTTP request may still finish.
    const read = async <T>(operation: () => Promise<T>) => {
      signal.throwIfAborted();
      const result = await operation();
      signal.throwIfAborted();
      return result;
    };
    try {
      const instruments = await read(() => broker.getInstruments(requests));
      const quotesObservedAt = new Date(now()).toISOString();
      const quotes = await read(() => broker.getQuotes(requests));
      for (const entries of [instruments.map((item) => item.id), quotes.map((item) => item.instrument)]) {
        const returned = new Set(entries.map(key));
        if (entries.length !== keys.size || returned.size !== keys.size || [...keys].some((id) => !returned.has(id)))
          throw new Error('PAPER_SOURCE_INSTRUMENT_MISMATCH');
      }
      const calendars = new Map<
        string,
        { calendar: Awaited<ReturnType<MarketBroker['getMarketCalendar']>>; observedAt: string }
      >();
      for (const market of new Set(requests.map((instrument) => instrument.market))) {
        const observedAt = new Date(now()).toISOString();
        const calendar = await read(() => broker.getMarketCalendar(market));
        if (
          [calendar.today, calendar.previousBusinessDay, calendar.nextBusinessDay].some((day) => day.market !== market)
        )
          throw new Error('PAPER_SOURCE_CALENDAR_MISMATCH');
        calendars.set(market, { calendar, observedAt });
      }
      const fx = await read(() => broker.getExchangeRate('USD', 'KRW'));
      if (fx.baseCurrency !== 'USD' || fx.quoteCurrency !== 'KRW') throw new Error('PAPER_SOURCE_CURRENCY_MISMATCH');
      const evidence: PaperEvidence[] = [];
      for (const request of requests) {
        const instrument = instruments.find((item) => key(item.id) === key(request))!;
        const quote = quotes.find((item) => key(item.instrument) === key(request))!;
        const currency = request.market === 'KR' ? 'KRW' : 'USD';
        if (instrument.currency !== currency || quote.currency !== currency)
          throw new Error('PAPER_SOURCE_CURRENCY_MISMATCH');
        const candlesObservedAt = new Date(now()).toISOString();
        const candles = await read(() => collectCandles(broker, request, '1m', maxPages, signal));
        const calendar = calendars.get(request.market)!;
        evidence.push(
          paperEvidenceSchema.parse({
            sourcesHealthy: true,
            // This source is only for the internal Paper ledger, never broker orders.
            hasUnknownOrders: false,
            quote: {
              instrument: request,
              price: quote.price,
              timestamp: quote.timestamp,
              observedAt: quotesObservedAt,
            },
            marketData: {
              nxtSupported: instrument.nxtSupported,
              restricted:
                instrument.status !== 'ACTIVE' ||
                (request.market === 'KR' &&
                  (instrument.krxTradingSuspended !== false ||
                    instrument.nxtSupported === null ||
                    (instrument.nxtSupported && instrument.nxtTradingSuspended !== false))),
              candles,
              candlesObservedAt,
              calendar: calendar.calendar,
              calendarObservedAt: calendar.observedAt,
              exchangeRate: { validFrom: fx.validFrom, validUntil: fx.validUntil },
            },
          }),
        );
      }
      signal.throwIfAborted();
      return evidence;
    } finally {
      busy = false;
    }
  };
}
