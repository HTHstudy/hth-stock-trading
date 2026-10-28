import { getPaper } from './endpoints/get-paper';
import { stopPaper } from './endpoints/stop-paper';
import { updateStrategy } from './endpoints/update-strategy';

export const PAPER_API = { get: getPaper, stop: stopPaper, updateStrategy };
export type { PaperDashboardSnapshot, PaperDashboardState } from '@hth/contracts';
