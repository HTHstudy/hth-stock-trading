import { z } from 'zod';
import { observationReportSchema } from '@hth/contracts';
import { observationsRequest } from '../observations-http-client';
export async function getReport(id: string, signal?: AbortSignal) {
  return observationReportSchema.parse(await observationsRequest(`/${z.uuid().parse(id)}`, signal));
}
