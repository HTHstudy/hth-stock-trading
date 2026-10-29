import { getPaper } from './endpoints/get-paper';
import { stopPaper } from './endpoints/stop-paper';
import { updateStrategy } from './endpoints/update-strategy';
import { getStrategyHistory } from './endpoints/get-strategy-history';

export const PAPER_API = { get: getPaper, stop: stopPaper, updateStrategy, strategyHistory: getStrategyHistory };
export type { PaperDashboardSnapshot, PaperDashboardState } from '@hth/contracts';
