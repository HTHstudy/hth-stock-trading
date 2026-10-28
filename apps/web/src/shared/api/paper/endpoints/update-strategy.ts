import { paperStrategyAcknowledgementSchema } from '@hth/contracts';
import { paperRequest } from '../paper-http-client';
export async function updateStrategy(id: string, input: unknown) {
  return paperStrategyAcknowledgementSchema.parse(
    await paperRequest(`/strategies/${encodeURIComponent(id)}`, 'POST', undefined, input),
  );
}
