import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { ownerLoginSchema } from '@hth/contracts';
import type { OwnerSession } from '@hth/contracts';

export const ownerHashPattern = /^scrypt-v1:[a-f0-9]{32}:[a-f0-9]{128}$/;
const cookieName = 'hth_owner_session';
const lifetime = 8 * 3600_000;
const idle = 30 * 60_000;
const windowMs = 15 * 60_000;
async function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, 64, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }, (error, key) =>
      error ? reject(new Error('OWNER_HASH_FAILED')) : resolve(key),
    ),
  );
}
export async function hashOwnerPassword(password: string) {
  const input = ownerLoginSchema.parse({ password });
  const salt = randomBytes(16);
  return `scrypt-v1:${salt.toString('hex')}:${(await derive(input.password, salt)).toString('hex')}`;
}
function cookieToken(header: string | undefined) {
  const values = (header ?? '')
    .split(';')
    .map((item) => item.trim())
    .filter((item) => item.startsWith(`${cookieName}=`));
  if (values.length !== 1) return null;
  const value = values[0]!.slice(cookieName.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}
const digest = (value: string) => createHash('sha256').update(value).digest();
const attributes = 'Path=/; HttpOnly; SameSite=Strict';
export interface OwnerAuth {
  read(cookie?: string): OwnerSession;
  login(password: string): Promise<{ session: OwnerSession; cookie: string }>;
  logout(cookie?: string): string;
  close(): void;
}
export function createOwnerAuth(passwordHash?: string, now: () => number = Date.now): OwnerAuth {
  if (passwordHash !== undefined && !ownerHashPattern.test(passwordHash)) throw new Error('OWNER_HASH_INVALID');
  let current: { hash: Buffer; expires: number; lastSeen: number } | undefined;
  let attempts = 0;
  let windowStart = now();
  let busy = false;
  let closed = false;
  function read(cookie?: string): OwnerSession {
    const time = now();
    if (current && (closed || time >= current.expires || time - current.lastSeen >= idle)) current = undefined;
    const token = cookieToken(cookie);
    if (!current || !token || !timingSafeEqual(current.hash, digest(token)))
      return { configured: Boolean(passwordHash), authenticated: false, expiresAt: null };
    current.lastSeen = time;
    return {
      configured: true,
      authenticated: true,
      expiresAt: new Date(Math.min(current.expires, time + idle)).toISOString(),
    };
  }
  return {
    read,
    async login(password) {
      if (!passwordHash || closed) throw new Error('OWNER_NOT_CONFIGURED');
      if (now() - windowStart >= windowMs) {
        windowStart = now();
        attempts = 0;
      }
      if (busy || attempts >= 5) throw new Error('OWNER_RATE_LIMITED');
      const input = ownerLoginSchema.safeParse({ password });
      if (!input.success) throw new Error('OWNER_LOGIN_FAILED');
      attempts++;
      busy = true;
      try {
        const [, salt, expected] = passwordHash.split(':');
        const actual = await derive(input.data.password, Buffer.from(salt!, 'hex'));
        if (!timingSafeEqual(actual, Buffer.from(expected!, 'hex')) || closed) throw new Error('OWNER_LOGIN_FAILED');
        const token = randomBytes(32).toString('base64url');
        current = { hash: digest(token), expires: now() + lifetime, lastSeen: now() };
        attempts = 0;
        return {
          session: read(`${cookieName}=${token}`),
          cookie: `${cookieName}=${token}; ${attributes}; Max-Age=${lifetime / 1000}`,
        };
      } finally {
        busy = false;
      }
    },
    logout(cookie) {
      const token = cookieToken(cookie);
      if (current && token && timingSafeEqual(current.hash, digest(token))) current = undefined;
      return `${cookieName}=; ${attributes}; Max-Age=0`;
    },
    close() {
      closed = true;
      current = undefined;
    },
  };
}
