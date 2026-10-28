import { ownerSessionSchema } from '@hth/contracts';
import { authRequest } from '../auth-http-client';
export async function getSession(signal?: AbortSignal) {
  return ownerSessionSchema.parse(await authRequest('session', undefined, signal));
}
