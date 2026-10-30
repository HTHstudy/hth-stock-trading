import { beforeAll, describe, expect, it } from 'vitest';
import { createOwnerAuth, hashOwnerPassword } from './owner-auth.js';
import { createApp } from './app.js';
import { testOwnerHash } from '../test/app.js';
import { parseApiConfig } from './config.js';

const password = 'synthetic-test-owner-password-only';
const headers = { host: 'localhost:4000', 'x-hth-dashboard': '1' };
let hash: string;
beforeAll(async () => {
  hash = await hashOwnerPassword(password);
}, 10_000);
const cookieOf = (value: string) => value.split(';')[0]!;
describe('소유자 인증과 서버 세션', () => {
  it('해시는 salt마다 다르고 원문 비밀번호를 포함하지 않는다', async () => {
    const other = await hashOwnerPassword(password);
    expect(other).not.toBe(hash);
    expect(other).not.toContain(password);
    expect(() => createOwnerAuth('plaintext-password')).toThrow('OWNER_HASH_INVALID');
    await expect(hashOwnerPassword('short')).rejects.toThrow();
  });
  it('기본 상태는 비공개 API를 닫고 생존·인증 상태만 제공한다', async () => {
    const app = createApp();
    try {
      expect((await app.inject({ method: 'GET', url: '/health/live' })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/v1/auth/session', headers })).json()).toEqual({
        configured: false,
        authenticated: false,
        expiresAt: null,
      });
      for (const path of [
        '/v1/dashboard',
        '/v1/backtests',
        '/v1/paper',
        '/v1/paper/strategies/demo-ma/history',
        '/v1/paper/equity',
        '/v1/observations/jobs',
      ])
        expect((await app.inject({ method: 'GET', url: path, headers })).statusCode).toBe(503);
      expect(() => parseApiConfig({ DASHBOARD_ENABLED: 'true' })).toThrow();
      expect(parseApiConfig({ DASHBOARD_ENABLED: 'true', OWNER_PASSWORD_HASH: testOwnerHash }).DASHBOARD_ENABLED).toBe(
        true,
      );
    } finally {
      await app.close();
    }
  });
  it('로그인 전 조회·정지·설정 변경을 차단하고 cookie로만 소유자를 식별한다', async () => {
    const app = createApp('silent', undefined, undefined, undefined, undefined, createOwnerAuth(hash));
    try {
      for (const path of [
        '/v1/dashboard',
        '/v1/backtests',
        '/v1/paper',
        '/v1/paper/strategies/demo-ma/history',
        '/v1/paper/equity',
        '/v1/observations/jobs',
      ])
        expect((await app.inject({ method: 'GET', url: path, headers })).statusCode).toBe(401);
      for (const path of ['/v1/paper/stop', '/v1/paper/strategies/demo-ma'])
        expect((await app.inject({ method: 'POST', url: path, headers, payload: {} })).statusCode).toBe(401);
      const login = await app.inject({ method: 'POST', url: '/v1/auth/login', headers, payload: { password } });
      expect(login.statusCode).toBe(200);
      expect(login.json().authenticated).toBe(true);
      const cookie = String(login.headers['set-cookie']);
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Strict');
      expect(cookie).not.toContain('Domain=');
      expect(login.body).not.toContain(password);
      expect(login.body).not.toContain(cookieOf(cookie).split('=')[1]!);
      expect(
        (await app.inject({ method: 'GET', url: '/v1/paper', headers: { ...headers, cookie: cookieOf(cookie) } }))
          .statusCode,
      ).toBe(200);
      expect(
        (await app.inject({ method: 'GET', url: '/v1/paper', headers: { ...headers, authorization: 'Bearer forged' } }))
          .statusCode,
      ).toBe(401);
      await app.inject({
        method: 'POST',
        url: '/v1/auth/logout',
        headers: { ...headers, cookie: cookieOf(cookie) },
        payload: {},
      });
      expect(
        (await app.inject({ method: 'GET', url: '/v1/paper', headers: { ...headers, cookie: cookieOf(cookie) } }))
          .statusCode,
      ).toBe(401);
    } finally {
      await app.close();
    }
  });
  it('CSRF·외부 접근·추가 로그인 필드는 자격 검증 전에 거부한다', async () => {
    const app = createApp('silent', undefined, undefined, undefined, undefined, createOwnerAuth(hash));
    try {
      for (const override of [
        { host: 'evil.invalid' },
        { ...headers, origin: 'https://evil.invalid' },
        { ...headers, 'sec-fetch-site': 'cross-site' },
        { host: 'localhost:4000' },
      ])
        expect(
          (await app.inject({ method: 'POST', url: '/v1/auth/login', headers: override, payload: { password } }))
            .statusCode,
        ).toBe(403);
      expect(
        (await app.inject({ method: 'POST', url: '/v1/auth/login', headers, payload: { password, role: 'owner' } }))
          .statusCode,
      ).toBe(400);
    } finally {
      await app.close();
    }
  });
  it('절대·유휴 만료, 새 로그인 회전, 위조·중복 cookie를 검사한다', async () => {
    let now = 0;
    const owner = createOwnerAuth(hash, () => now);
    const first = await owner.login(password);
    const cookie = cookieOf(first.cookie);
    expect(owner.read(cookie).authenticated).toBe(true);
    expect(owner.read(`${cookie}; ${cookie}`).authenticated).toBe(false);
    expect(owner.read('hth_owner_session=forged').authenticated).toBe(false);
    const second = await owner.login(password);
    expect(owner.read(cookie).authenticated).toBe(false);
    now += 30 * 60_000;
    expect(owner.read(cookieOf(second.cookie)).authenticated).toBe(false);
    const third = await owner.login(password);
    for (let hour = 0; hour < 8; hour++) {
      now += 29 * 60_000;
      owner.read(cookieOf(third.cookie));
    }
    now = 30 * 60_000 + 8 * 3600_000;
    expect(owner.read(cookieOf(third.cookie)).authenticated).toBe(false);
    owner.close();
    await expect(owner.login(password)).rejects.toThrow('OWNER_NOT_CONFIGURED');
  }, 10_000);
  it('KDF 동시 실행과 15분 창의 실패 횟수를 제한한다', async () => {
    let now = 0;
    const owner = createOwnerAuth(hash, () => now);
    const pending = owner.login('incorrect-synthetic-password');
    await expect(owner.login(password)).rejects.toThrow('OWNER_RATE_LIMITED');
    await expect(pending).rejects.toThrow('OWNER_LOGIN_FAILED');
    for (let index = 0; index < 4; index++)
      await expect(owner.login('incorrect-synthetic-password')).rejects.toThrow('OWNER_LOGIN_FAILED');
    await expect(owner.login(password)).rejects.toThrow('OWNER_RATE_LIMITED');
    now += 15 * 60_000;
    expect((await owner.login(password)).session.authenticated).toBe(true);
  }, 15_000);
});
