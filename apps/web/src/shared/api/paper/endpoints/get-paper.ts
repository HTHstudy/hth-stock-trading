import { paperDashboardStateSchema } from '@hth/contracts';
import { paperRequest } from '../paper-http-client';

export async function getPaper(signal?: AbortSignal) {
  return paperDashboardStateSchema.parse(await paperRequest('', 'GET', signal));
}
