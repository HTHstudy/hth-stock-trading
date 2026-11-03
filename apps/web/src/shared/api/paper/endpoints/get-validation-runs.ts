import { paperValidationStatusSchema } from '@hth/contracts';
import { paperRequest } from '../paper-http-client';

export async function getValidationRuns(signal?: AbortSignal) {
  return paperValidationStatusSchema.parse(await paperRequest('/validation-runs', 'GET', signal));
}
