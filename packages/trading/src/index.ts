import type { Candle, DecimalString, InstrumentId } from '@hth/contracts';

export { assessCandle } from './market-data/candles.js';
export { prepareStrategyData } from './market-data/readiness.js';
export { marketDataPolicy } from './market-data/policy.js';
export type { StrategyDataInput } from './market-data/readiness.js';
export type { CandleAssessment, DataBlocker } from './market-data/policy.js';

export interface StrategyContext {
  readonly instrument: InstrumentId;
  readonly evaluatedAt: string;
  readonly closedCandles: readonly Candle[];
  readonly ownedQuantity: DecimalString;
}

export interface StrategySignal {
  readonly action: 'BUY' | 'SELL' | 'HOLD';
  readonly reason: string;
}

export interface Strategy<Config> {
  readonly id: string;
  readonly version: string;
  evaluate(context: StrategyContext, config: Config): StrategySignal;
}
