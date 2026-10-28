import type { Candle, Currency, DecimalString, InstrumentId, Market, MarketCalendar, Money } from '@hth/contracts';
export type { MarketSession, MarketDay, MarketCalendar } from '@hth/contracts';

export interface BrokerAccount {
  readonly reference: string;
  readonly type: string;
}

export interface Holding {
  readonly instrument: InstrumentId;
  readonly quantity: DecimalString;
  readonly currency: Currency;
  readonly name: string;
  readonly averagePurchasePrice: DecimalString;
  readonly lastPrice: DecimalString;
}

export interface Quote {
  readonly instrument: InstrumentId;
  readonly price: DecimalString;
  readonly currency: Currency;
  readonly timestamp: string | null;
}

export interface BrokerInstrument {
  readonly id: InstrumentId;
  readonly name: string;
  readonly currency: Currency;
  readonly exchange: string;
  readonly status: string;
  readonly krxTradingSuspended: boolean | null;
  readonly nxtTradingSuspended: boolean | null;
  readonly nxtSupported: boolean | null;
}

export interface ExchangeRate {
  readonly baseCurrency: Currency;
  readonly quoteCurrency: Currency;
  readonly rate: DecimalString;
  readonly midRate: DecimalString;
  readonly validFrom: string;
  readonly validUntil: string;
}

export interface CandleQuery {
  readonly instrument: InstrumentId;
  readonly interval: Candle['interval'];
  readonly count: number;
  readonly adjusted: boolean;
  readonly before?: string;
}

export interface CandlePage {
  readonly candles: readonly Candle[];
  readonly nextBefore: string | null;
}

export interface ReadonlyBroker {
  readonly id: string;
  listAccounts(): Promise<readonly BrokerAccount[]>;
  getHoldings(account: BrokerAccount): Promise<readonly Holding[]>;
  getBuyingPower(account: BrokerAccount, currency: Currency): Promise<Money>;
  getInstruments(instruments: readonly InstrumentId[]): Promise<readonly BrokerInstrument[]>;
  getQuotes(instruments: readonly InstrumentId[]): Promise<readonly Quote[]>;
  getCandles(query: CandleQuery): Promise<CandlePage>;
  getExchangeRate(baseCurrency: Currency, quoteCurrency: Currency): Promise<ExchangeRate>;
  getMarketCalendar(market: Market, date?: string): Promise<MarketCalendar>;
}

export { BrokerError } from './errors.js';
