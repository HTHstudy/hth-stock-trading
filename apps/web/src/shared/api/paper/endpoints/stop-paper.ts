import { paperStopAcknowledgementSchema } from '@hth/contracts';
import { paperRequest } from '../paper-http-client';

export async function stopPaper() {
  return paperStopAcknowledgementSchema.parse(await paperRequest('/stop', 'POST'));
}
