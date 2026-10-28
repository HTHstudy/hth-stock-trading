import { getReports } from './endpoints/get-reports';
import { getReport } from './endpoints/get-report';

export const BACKTESTS_API = { list: getReports, get: getReport };
export type { BacktestArtifact, BacktestSummary } from '@hth/contracts';
