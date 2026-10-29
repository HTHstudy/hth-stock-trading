import { paperEquityHistorySchema } from '@hth/contracts';
import { paperRequest } from '../paper-http-client';
export async function getEquityHistory(signal?: AbortSignal) {
  return paperEquityHistorySchema.parse(await paperRequest('/equity', 'GET', signal));
}
