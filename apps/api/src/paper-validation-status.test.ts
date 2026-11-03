import { expect, it, vi } from 'vitest';
import { parseApiConfig } from './config.js';
import { createApp } from './app.js';
import { createOwnerAuth } from './owner-auth.js';
import { createAuthenticatedTestApp, testOwnerHash } from '../test/app.js';

const status = () => ({
  service: 'paper-validation-status' as const,
  asOf: new Date().toISOString(),
  availability: 'not-recorded' as const,
  runs: [],
  rejectedCount: 0,
  limited: false,
  executionEnabled: false as const,
  canResume: false as const,
});
it('소유자 localhost 조회만 허용하고 외부 입력·쓰기·미설정을 차단한다', async () => {
  const list = vi.fn(async () => status());
  const args: Parameters<typeof createApp> = [];
  args[10] = { list };
  const app = createAuthenticatedTestApp(...args);
  const unconfigured = createApp();
  const unsignedArgs: Parameters<typeof createApp> = [];
  unsignedArgs[5] = createOwnerAuth(testOwnerHash);
  unsignedArgs[10] = { list };
  const unsigned = createApp(...unsignedArgs);
  const headers = { host: 'localhost:4000' };
  try {
    const response = await app.inject({ url: '/v1/paper/validation-runs', headers });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ availability: 'not-recorded', canResume: false, executionEnabled: false });
    expect(response.headers['cache-control']).toBe('no-store, private');
    expect((await app.inject({ url: '/v1/paper/validation-runs?path=../../env', headers })).statusCode).toBe(400);
    expect(
      (await app.inject({ url: '/v1/paper/validation-runs', headers, remoteAddress: '192.168.1.2' })).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          url: '/v1/paper/validation-runs',
          headers: { ...headers, origin: 'https://outside.example' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ url: '/v1/paper/validation-runs', headers: { ...headers, host: 'outside.example' } }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/paper/validation-runs',
          headers: { ...headers, 'x-hth-dashboard': '1' },
          payload: { resume: true },
        })
      ).statusCode,
    ).toBe(404);
    expect((await unconfigured.inject({ url: '/v1/paper/validation-runs', headers })).statusCode).toBe(503);
    expect((await unsigned.inject({ url: '/v1/paper/validation-runs', headers })).statusCode).toBe(401);
    expect(list).toHaveBeenCalledOnce();
  } finally {
    await Promise.all([app.close(), unconfigured.close(), unsigned.close()]);
  }
});
it('보관 root 실패·조회 미구성·잘못된 DTO를 안전하게 처리한다', async () => {
  const unavailable: Parameters<typeof createApp> = [];
  unavailable[10] = { list: vi.fn(async () => ({ ...status(), availability: 'unavailable' as const })) };
  const bad: Parameters<typeof createApp> = [];
  bad[10] = { list: vi.fn(async () => ({ ...status(), accountId: 'PRIVATE_ACCOUNT' })) };
  const a = createAuthenticatedTestApp(...unavailable),
    b = createAuthenticatedTestApp(),
    c = createAuthenticatedTestApp(...bad);
  try {
    const headers = { host: 'localhost:4000' };
    expect((await a.inject({ url: '/v1/paper/validation-runs', headers })).statusCode).toBe(503);
    expect((await b.inject({ url: '/v1/paper/validation-runs', headers })).statusCode).toBe(503);
    const response = await c.inject({ url: '/v1/paper/validation-runs', headers });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('PRIVATE_ACCOUNT');
  } finally {
    await Promise.all([a.close(), b.close(), c.close()]);
  }
});

it('기본 비활성이며 활성화에는 소유자 설정과 loopback 환경이 필요하다', () => {
  expect(parseApiConfig({}).PAPER_VALIDATION_ENABLED).toBe(false);
  expect(() => parseApiConfig({ PAPER_VALIDATION_ENABLED: 'true' })).toThrow();
  expect(
    parseApiConfig({ PAPER_VALIDATION_ENABLED: 'true', OWNER_PASSWORD_HASH: testOwnerHash }).PAPER_VALIDATION_ENABLED,
  ).toBe(true);
  expect(() =>
    parseApiConfig({ PAPER_VALIDATION_ENABLED: 'true', OWNER_PASSWORD_HASH: testOwnerHash, API_HOST: '0.0.0.0' }),
  ).toThrow();
  expect(() =>
    parseApiConfig({ PAPER_VALIDATION_ENABLED: 'true', OWNER_PASSWORD_HASH: testOwnerHash, NODE_ENV: 'production' }),
  ).toThrow();
});
