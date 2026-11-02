import { paperPreparationDashboardSchema } from '@hth/contracts';
import { paperRequest } from '../paper-http-client';

export async function getPreparation(signal?: AbortSignal) {
  return paperPreparationDashboardSchema.parse(await paperRequest('/preparation', 'GET', signal));
}
