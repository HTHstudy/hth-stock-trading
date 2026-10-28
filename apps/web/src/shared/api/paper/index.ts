import { getPaper } from './endpoints/get-paper';
import { stopPaper } from './endpoints/stop-paper';

export const PAPER_API = { get: getPaper, stop: stopPaper };
export type { PaperDashboardSnapshot, PaperDashboardState } from '@hth/contracts';
