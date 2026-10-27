import type { Candle, Currency, DecimalString, InstrumentId } from '@hth/shared';

export interface BrokerAccount {
  readonly reference: string;
}

export interface Holding {
  readonly instrument: InstrumentId;
  readonly quantity: DecimalString;
  readonly currency: Currency;
}

export interface Quote {
  readonly instrument: InstrumentId;
  readonly price: DecimalString;
  readonly currency: Currency;
  readonly timestamp: string;
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
  getQuotes(instruments: readonly InstrumentId[]): Promise<readonly Quote[]>;
  getCandles(query: CandleQuery): Promise<CandlePage>;
}
