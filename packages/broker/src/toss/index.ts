import { currencySchema, instantSchema, marketSchema } from '@hth/contracts';
import type { Candle, Currency, InstrumentId, Market } from '@hth/contracts';
import { z } from 'zod';
import type { CandleQuery, MarketDay, MarketSession, ReadonlyBroker } from '../index.js';
import { BrokerError } from '../errors.js';
import {
  accountsDto,
  buyingPowerDto,
  candlesDto,
  exchangeRateDto,
  holdingsDto,
  instrumentsDto,
  krCalendarDto,
  quotesDto,
  usCalendarDto,
} from './dto.js';
import { createTransport } from './transport.js';
import type { TossOptions } from './transport.js';

export type { TossFetch, TossOptions } from './transport.js';

const instrumentSchema = z.object({
  market: marketSchema,
  symbol: z
    .string()
    .regex(/^[A-Za-z0-9.-]+$/)
    .max(40),
});
const instrumentsSchema = z.array(instrumentSchema).min(1).max(200);
const accountSchema = z.object({ reference: z.string().regex(/^\d+$/).max(16) });
const candleQuerySchema = z.object({
  instrument: instrumentSchema,
  interval: z.enum(['1m', '1d']),
  count: z.number().int().min(1).max(200),
  adjusted: z.boolean(),
  before: instantSchema.optional(),
});

function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new BrokerError('INVALID_INPUT');
  return result.data;
}

function supportedCurrency(raw: string): Currency {
  const parsed = currencySchema.safeParse(raw);
  if (!parsed.success) throw new BrokerError('UNSUPPORTED_MARKET');
  return parsed.data;
}

function currencyMarket(currency: Currency): Market {
  return currency === 'KRW' ? 'KR' : 'US';
}

function checkedCurrency(raw: string, market: Market): Currency {
  const currency = supportedCurrency(raw);
  if (currencyMarket(currency) !== market) throw new BrokerError('INVALID_RESPONSE');
  return currency;
}

function normalizeRequests(instruments: readonly InstrumentId[]) {
  const parsed = input(instrumentsSchema, instruments).map((instrument) => ({
    ...instrument,
    symbol: instrument.symbol.toUpperCase(),
  }));
  if (new Set(parsed.map((instrument) => instrument.symbol)).size !== parsed.length)
    throw new BrokerError('INVALID_INPUT');
  return parsed;
}

function matchInstrument(symbol: string, requests: readonly InstrumentId[]) {
  const instrument = requests.find((request) => request.symbol === symbol.toUpperCase());
  if (!instrument) throw new BrokerError('INVALID_RESPONSE');
  return instrument;
}

function requireAllSymbols(symbols: readonly string[], requests: readonly InstrumentId[]) {
  if (
    new Set(symbols.map((symbol) => symbol.toUpperCase())).size !== requests.length ||
    symbols.length !== requests.length
  ) {
    throw new BrokerError('INVALID_RESPONSE');
  }
}

function compareDecimal(left: string, right: string) {
  const [leftWhole = '', leftFraction = ''] = left.split('.');
  const [rightWhole = '', rightFraction = ''] = right.split('.');
  const scale = Math.max(leftFraction.length, rightFraction.length);
  const leftValue = BigInt(leftWhole + leftFraction.padEnd(scale, '0'));
  const rightValue = BigInt(rightWhole + rightFraction.padEnd(scale, '0'));
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function tradingDate(timestamp: string, query: Pick<CandleQuery, 'instrument' | 'interval'>) {
  const date = new Date(timestamp);
  const timeZone = query.instrument.market === 'KR' ? 'Asia/Seoul' : 'America/New_York';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? '';
  const day = `${part('year')}-${part('month')}-${part('day')}`;
  if (query.instrument.market === 'US' && query.interval === '1m') {
    const barStart = new Date(date.getTime() - 60_000);
    const startParts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(barStart);
    const startPart = (type: string) => startParts.find((entry) => entry.type === type)?.value ?? '';
    const startDay = `${startPart('year')}-${startPart('month')}-${startPart('day')}`;
    return Number(startPart('hour')) >= 20
      ? new Date(Date.parse(`${startDay}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
      : startDay;
  }
  return day;
}

type RawSession = { startTime: string; endTime: string } | null | undefined;

function mapDay(
  market: Market,
  date: string,
  sessions: readonly [MarketSession['type'], RawSession][],
  sessionsKnown: boolean,
): MarketDay {
  return {
    market,
    tradingDate: date,
    sessionsKnown,
    sessions: sessions.flatMap(([type, session]) =>
      session
        ? [
            {
              type,
              startsAt: new Date(session.startTime).toISOString(),
              endsAt: new Date(session.endTime).toISOString(),
            },
          ]
        : [],
    ),
  };
}

export function createTossReadonlyBroker(options: TossOptions): ReadonlyBroker {
  const transport = createTransport(options);
  return {
    id: 'toss',
    async listAccounts() {
      const data = await transport.get('/api/v1/accounts', 'ACCOUNT', accountsDto);
      return data.result.map((account) => ({ reference: String(account.accountSeq), type: account.accountType }));
    },
    async getHoldings(account) {
      const { reference } = input(accountSchema, account);
      const data = await transport.get('/api/v1/holdings', 'ASSET', holdingsDto, new URLSearchParams(), reference);
      return data.result.items.map((item) => {
        const market = marketSchema.safeParse(item.marketCountry);
        if (!market.success) throw new BrokerError('UNSUPPORTED_MARKET');
        return {
          instrument: { market: market.data, symbol: item.symbol.toUpperCase() },
          name: item.name,
          quantity: item.quantity,
          currency: checkedCurrency(item.currency, market.data),
          averagePurchasePrice: item.averagePurchasePrice,
          lastPrice: item.lastPrice,
        };
      });
    },
    async getBuyingPower(account, currency) {
      const { reference } = input(accountSchema, account);
      input(currencySchema, currency);
      const data = await transport.get(
        '/api/v1/buying-power',
        'ORDER_INFO',
        buyingPowerDto,
        new URLSearchParams({ currency }),
        reference,
      );
      if (supportedCurrency(data.result.currency) !== currency) throw new BrokerError('INVALID_RESPONSE');
      return { currency, amount: data.result.cashBuyingPower };
    },
    async getInstruments(instruments) {
      const requests = normalizeRequests(instruments);
      const data = await transport.get(
        '/api/v1/stocks',
        'STOCK',
        instrumentsDto,
        new URLSearchParams({ symbols: requests.map((instrument) => instrument.symbol).join(',') }),
      );
      requireAllSymbols(
        data.result.map((item) => item.symbol),
        requests,
      );
      return data.result.map((item) => {
        const id = matchInstrument(item.symbol, requests);
        const exchangeMarket = ['KOSPI', 'KOSDAQ', 'KR_ETC'].includes(item.market)
          ? 'KR'
          : ['NYSE', 'NASDAQ', 'AMEX', 'US_ETC'].includes(item.market)
            ? 'US'
            : null;
        if (!exchangeMarket) throw new BrokerError('UNSUPPORTED_MARKET');
        if (exchangeMarket !== id.market) throw new BrokerError('INVALID_RESPONSE');
        return {
          id,
          name: item.name,
          currency: checkedCurrency(item.currency, id.market),
          exchange: item.market,
          status: item.status,
          krxTradingSuspended: item.koreanMarketDetail?.krxTradingSuspended ?? null,
          nxtTradingSuspended: item.koreanMarketDetail?.nxtTradingSuspended ?? null,
          nxtSupported: item.koreanMarketDetail?.nxtSupported ?? null,
        };
      });
    },
    async getQuotes(instruments) {
      const requests = normalizeRequests(instruments);
      const data = await transport.get(
        '/api/v1/prices',
        'MARKET_DATA',
        quotesDto,
        new URLSearchParams({ symbols: requests.map((instrument) => instrument.symbol).join(',') }),
      );
      requireAllSymbols(
        data.result.map((item) => item.symbol),
        requests,
      );
      return data.result.map((item) => {
        const instrument = matchInstrument(item.symbol, requests);
        return {
          instrument,
          price: item.lastPrice,
          currency: checkedCurrency(item.currency, instrument.market),
          timestamp: item.timestamp ? new Date(item.timestamp).toISOString() : null,
        };
      });
    },
    async getCandles(query) {
      const parsed = input(candleQuerySchema, query);
      const parameters = new URLSearchParams({
        symbol: parsed.instrument.symbol.toUpperCase(),
        interval: parsed.interval,
        count: String(parsed.count),
        adjusted: String(parsed.adjusted),
      });
      if (parsed.before) parameters.set('before', parsed.before);
      const data = await transport.get('/api/v1/candles', 'MARKET_DATA_CHART', candlesDto, parameters);
      const normalized = new Map<string, Candle>();
      for (const item of data.result.candles) {
        if (
          compareDecimal(item.lowPrice, item.highPrice) > 0 ||
          compareDecimal(item.openPrice, item.lowPrice) < 0 ||
          compareDecimal(item.openPrice, item.highPrice) > 0 ||
          compareDecimal(item.closePrice, item.lowPrice) < 0 ||
          compareDecimal(item.closePrice, item.highPrice) > 0 ||
          (parsed.before && Date.parse(item.timestamp) > Date.parse(parsed.before))
        )
          throw new BrokerError('INVALID_RESPONSE');
        const candle: Candle = {
          instrument: { ...parsed.instrument, symbol: parsed.instrument.symbol.toUpperCase() },
          interval: parsed.interval,
          timestamp: new Date(item.timestamp).toISOString(),
          tradingDate: tradingDate(item.timestamp, parsed),
          open: item.openPrice,
          high: item.highPrice,
          low: item.lowPrice,
          close: item.closePrice,
          volume: item.volume,
          currency: checkedCurrency(item.currency, parsed.instrument.market),
          adjusted: parsed.adjusted,
          source: 'toss',
          isClosed: false,
        };
        const duplicate = normalized.get(candle.timestamp);
        if (duplicate && JSON.stringify(duplicate) !== JSON.stringify(candle))
          throw new BrokerError('INVALID_RESPONSE');
        normalized.set(candle.timestamp, candle);
      }
      return {
        candles: [...normalized.values()].sort(
          (left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp),
        ),
        nextBefore: data.result.nextBefore ?? null,
      };
    },
    async getExchangeRate(baseCurrency, quoteCurrency) {
      input(currencySchema, baseCurrency);
      input(currencySchema, quoteCurrency);
      if (baseCurrency === quoteCurrency) throw new BrokerError('INVALID_INPUT');
      const data = await transport.get(
        '/api/v1/exchange-rate',
        'MARKET_INFO',
        exchangeRateDto,
        new URLSearchParams({ baseCurrency, quoteCurrency }),
      );
      if (
        supportedCurrency(data.result.baseCurrency) !== baseCurrency ||
        supportedCurrency(data.result.quoteCurrency) !== quoteCurrency
      )
        throw new BrokerError('INVALID_RESPONSE');
      return {
        baseCurrency,
        quoteCurrency,
        rate: data.result.rate,
        midRate: data.result.midRate,
        validFrom: new Date(data.result.validFrom).toISOString(),
        validUntil: new Date(data.result.validUntil).toISOString(),
      };
    },
    async getMarketCalendar(market, date) {
      input(marketSchema, market);
      if (date !== undefined) input(z.iso.date(), date);
      const query = new URLSearchParams(date ? { date } : {});
      if (market === 'KR') {
        const data = await transport.get('/api/v1/market-calendar/KR', 'MARKET_INFO', krCalendarDto, query);
        const map = (day: z.infer<typeof krCalendarDto>['result']['today']) => {
          const sessions: [MarketSession['type'], RawSession][] = [
            ['pre', day.integrated?.preMarket],
            ['regular', day.integrated?.regularMarket],
            ['after', day.integrated?.afterMarket],
          ];
          return mapDay(
            market,
            day.date,
            sessions,
            day.integrated === null ||
              (day.integrated !== undefined && sessions.every(([, session]) => session !== undefined)),
          );
        };
        return {
          today: map(data.result.today),
          previousBusinessDay: map(data.result.previousBusinessDay),
          nextBusinessDay: map(data.result.nextBusinessDay),
        };
      }
      const data = await transport.get('/api/v1/market-calendar/US', 'MARKET_INFO', usCalendarDto, query);
      const map = (day: z.infer<typeof usCalendarDto>['result']['today']) => {
        const sessions: [MarketSession['type'], RawSession][] = [
          ['day', day.dayMarket],
          ['pre', day.preMarket],
          ['regular', day.regularMarket],
          ['after', day.afterMarket],
        ];
        return mapDay(
          market,
          day.date,
          sessions,
          sessions.every(([, session]) => session !== undefined),
        );
      };
      return {
        today: map(data.result.today),
        previousBusinessDay: map(data.result.previousBusinessDay),
        nextBusinessDay: map(data.result.nextBusinessDay),
      };
    },
  };
}
