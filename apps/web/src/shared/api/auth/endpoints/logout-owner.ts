import { ownerSessionSchema } from '@hth/contracts';
import { authRequest } from '../auth-http-client';
export async function logoutOwner() {
  return ownerSessionSchema.parse(await authRequest('logout', {}));
}
