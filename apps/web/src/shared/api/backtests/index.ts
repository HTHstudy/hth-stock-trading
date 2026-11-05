import { getReports } from './endpoints/get-reports';
import { getReport } from './endpoints/get-report';
import { getComparison } from './endpoints/get-comparison';

export const BACKTESTS_API = { list: getReports, get: getReport, compare: getComparison };
export type { BacktestArtifact, BacktestSummary, BacktestCostPair } from '@hth/contracts';
