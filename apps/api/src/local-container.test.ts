import { expect, it } from 'vitest';
import { parseApiConfig } from './config.js';
import { testOwnerHash } from '../test/app.js';
import { createApp } from './app.js';

const local = { NODE_ENV: 'production', LOCAL_CONTAINER_MODE: 'true', API_HOST: '127.0.0.1' };
it('명시적 로컬 컨테이너만 운영 산출물에서 로컬 접근을 허용한다', () => {
  expect(parseApiConfig({ ...local, OWNER_PASSWORD_HASH: '', LOCAL_WEB_PORT: '59080' })).toMatchObject({
    LOCAL_CONTAINER_MODE: true,
    LOCAL_WEB_PORT: 59080,
    OWNER_PASSWORD_HASH: undefined,
    DASHBOARD_ENABLED: false,
  });
  expect(
    parseApiConfig({ ...local, DASHBOARD_ENABLED: 'true', OWNER_PASSWORD_HASH: testOwnerHash }).DASHBOARD_ENABLED,
  ).toBe(true);
  for (const patch of [
    { API_HOST: '0.0.0.0' },
    { API_HOST: 'api' },
    { NODE_ENV: 'development' },
    { TRADING_MODE: 'live' },
    { LOCAL_WEB_PORT: '0' },
    { LOCAL_WEB_PORT: 'https://public.example' },
    { DASHBOARD_ENABLED: 'true' },
    { OWNER_PASSWORD_HASH: 'invalid' },
  ])
    expect(() => parseApiConfig({ ...local, ...patch })).toThrow();
  expect(() =>
    parseApiConfig({ NODE_ENV: 'production', DASHBOARD_ENABLED: 'true', OWNER_PASSWORD_HASH: testOwnerHash }),
  ).toThrow();
});

it('로컬 포트를 추가해도 외부 IP·교차 origin·위조 forwarded 헤더는 허용하지 않는다', async () => {
  const origin = 'http://127.0.0.1:59080';
  const app = createApp('silent', undefined, [origin]);
  try {
    expect(
      (await app.inject({ url: '/v1/auth/session', headers: { host: '127.0.0.1:59080', origin } })).statusCode,
    ).toBe(200);
    for (const request of [
      { remoteAddress: '172.18.0.2', headers: { host: '127.0.0.1:59080', origin, 'x-forwarded-for': '127.0.0.1' } },
      { headers: { host: '127.0.0.1:59080', origin: 'https://outside.example' } },
      { headers: { host: 'outside.example', origin } },
      { headers: { host: '127.0.0.1:59080', origin, 'sec-fetch-site': 'cross-site' } },
    ])
      expect((await app.inject({ url: '/v1/auth/session', ...request })).statusCode).toBe(403);
    expect(
      (await app.inject({ url: '/v1/observations', headers: { host: '127.0.0.1:59080', origin } })).statusCode,
    ).toBe(503);
  } finally {
    await app.close();
  }
});
