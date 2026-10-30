import { createApp } from '../src/app.js';
import type { OwnerAuth } from '../src/owner-auth.js';

export const testOwnerHash = `scrypt-v1:${'00'.repeat(16)}:${'00'.repeat(64)}`;
export function createAuthenticatedTestApp(...args: Parameters<typeof createApp>) {
  const owner: OwnerAuth = {
    read: () => ({ configured: true, authenticated: true, expiresAt: '2099-01-01T00:00:00Z' }),
    login: async () => {
      throw new Error('UNUSED_TEST_LOGIN');
    },
    logout: () => '',
    close: () => {},
  };
  return createApp(args[0], args[1], args[2], args[3], args[4], owner, args[6], args[7], args[8]);
}
