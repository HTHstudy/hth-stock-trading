import { ownerSessionSchema } from '@hth/contracts';
import { authRequest } from '../auth-http-client';
export async function loginOwner(password: string) {
  return ownerSessionSchema.parse(await authRequest('login', { password }));
}
