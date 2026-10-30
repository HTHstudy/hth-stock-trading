import { observationJobsSchema } from '@hth/contracts';
import { observationsRequest } from '../observations-http-client';
export async function getJobs(signal?: AbortSignal) {
  return observationJobsSchema.parse(await observationsRequest('/jobs', signal));
}
