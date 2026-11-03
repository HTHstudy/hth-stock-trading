import { getPaper } from './endpoints/get-paper';
import { stopPaper } from './endpoints/stop-paper';
import { updateStrategy } from './endpoints/update-strategy';
import { getStrategyHistory } from './endpoints/get-strategy-history';
import { getEquityHistory } from './endpoints/get-equity-history';
import { getDiagnostics } from './endpoints/get-diagnostics';
import { getPreparation } from './endpoints/get-preparation';

import { getValidationRuns } from './endpoints/get-validation-runs';

export const PAPER_API = {
  validationRuns: getValidationRuns,
  preparation: getPreparation,
  diagnostics: getDiagnostics,
  get: getPaper,
  stop: stopPaper,
  updateStrategy,
  strategyHistory: getStrategyHistory,
  equityHistory: getEquityHistory,
};
export type { PaperDashboardSnapshot, PaperDashboardState } from '@hth/contracts';
