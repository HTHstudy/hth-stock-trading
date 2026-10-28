import { backtestArtifactSchema, reportHashSchema } from '@hth/contracts';
import { backtestsRequest } from '../backtests-http-client';

export async function getReport(hash: string, signal?: AbortSignal) {
  const id = reportHashSchema.parse(hash);
  return backtestArtifactSchema.parse(await backtestsRequest(`/${id}`, signal));
}
