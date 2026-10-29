import { paperStrategyHistorySchema, paperStrategyHistoryQuerySchema } from '@hth/contracts';
import { paperRequest } from '../paper-http-client';
export async function getStrategyHistory(id: string, beforeRevision?: number, signal?: AbortSignal) {
  const query = paperStrategyHistoryQuerySchema.parse(beforeRevision === undefined ? {} : { beforeRevision });
  const suffix = query.beforeRevision === undefined ? '' : `?beforeRevision=${query.beforeRevision}`;
  return paperStrategyHistorySchema.parse(
    await paperRequest(`/strategies/${encodeURIComponent(id)}/history${suffix}`, 'GET', signal),
  );
}
