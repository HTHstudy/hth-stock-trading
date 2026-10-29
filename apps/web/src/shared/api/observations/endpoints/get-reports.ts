import { observationListSchema } from '@hth/contracts';
import { observationsRequest } from '../observations-http-client';
export async function getReports(signal?: AbortSignal) {
  return observationListSchema.parse(await observationsRequest('', signal));
}
