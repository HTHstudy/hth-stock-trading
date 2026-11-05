import { backtestCostPairSchema, reportHashSchema } from '@hth/contracts';
import { backtestsRequest } from '../backtests-http-client';

export async function getComparison(leftHash: string, rightHash: string, signal?: AbortSignal) {
  const left = reportHashSchema.parse(leftHash);
  const right = reportHashSchema.parse(rightHash);
  const query = new URLSearchParams({ left, right });
  const pair = backtestCostPairSchema.parse(await backtestsRequest(`?${query}`, signal, 'backtest-comparison'));
  if (pair.leftReportHash !== left || pair.rightReportHash !== right) throw new Error('COMPARISON_PAIR_MISMATCH');
  return pair;
}
