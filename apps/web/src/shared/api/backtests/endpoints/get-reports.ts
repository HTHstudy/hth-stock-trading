import { backtestListSchema } from '@hth/contracts';
import { backtestsRequest } from '../backtests-http-client';

export async function getReports(signal?: AbortSignal) {
  return backtestListSchema.parse(await backtestsRequest('', signal));
}
