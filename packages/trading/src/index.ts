import type { Candle, DecimalString, InstrumentId } from '@hth/contracts';

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
