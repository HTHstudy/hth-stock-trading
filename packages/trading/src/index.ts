export { assessCandle } from './market-data/candles.js';
export { prepareStrategyData } from './market-data/readiness.js';
export { marketDataPolicy, marketDate as marketTradingDate } from './market-data/policy.js';
export { historicalDates, buildHistoricalDataset } from './market-data/historical.js';
export type { StrategyDataInput } from './market-data/readiness.js';
export type { CandleAssessment, DataBlocker } from './market-data/policy.js';

export type { Strategy, StrategyContext, StrategySignal } from './strategy/types.js';
export { movingAverageCross } from './strategy/moving-average.js';
