import { expect, it } from 'vitest';
import { dedicatedPaperDatabaseUrl, localComposeEnvironment } from './local-compose.js';
const env = {
  NODE_ENV: 'production',
  LOCAL_CONTAINER_MODE: 'true',
  LOCAL_DB_PASSWORD: 'a@b:/#%',
  LOCAL_PAPER_DB_PASSWORD: 'different@:/#%',
  LOCAL_PAPER_ACCOUNT_ID: 'paper-demo-local',
};
it('명시적 Compose에서 두 프로세스가 같은 잠금 DB와 별도 Paper 역할을 사용한다', () => {
  const first = localComposeEnvironment(env),
    second = localComposeEnvironment({ ...env });
  expect(first).toEqual(second);
  const broker = new URL(first.DATABASE_URL!),
    paper = new URL(first.PAPER_DEMO_DATABASE_URL!);
  expect(broker.hostname).toBe('db');
  expect(broker.pathname).toBe('/hth_trading');
  expect(broker.username).toBe('hth');
  expect(paper.pathname).toBe('/hth_readonly_test');
  expect(paper.username).toBe('hth_test');
  expect(decodeURIComponent(broker.password)).toBe(env.LOCAL_DB_PASSWORD);
  expect(decodeURIComponent(paper.password)).toBe(env.LOCAL_PAPER_DB_PASSWORD);
  expect(localComposeEnvironment({ ...env, LOCAL_CONTAINER_MODE: 'false' })).toEqual({});
  expect(() => localComposeEnvironment({ ...env, NODE_ENV: 'development' })).toThrow();
});
it('기존 localhost 범위는 유지하고 db 주소는 명시적 Compose에만 허용한다', () => {
  const url = 'postgresql://hth_test:fixture@db:5432/hth_readonly_test';
  expect(() => dedicatedPaperDatabaseUrl(url)).toThrow('UNSAFE_TEST_DATABASE');
  expect(dedicatedPaperDatabaseUrl(url, true)).toBe(url);
  for (const value of [
    url.replace('db:5432', 'remote:5432'),
    url.replace('5432', '5433'),
    url + '?options=unsafe',
    url + '#host',
    url.replace('hth_test:', 'hth:'),
    url.replace('/hth_readonly_test', '/hth_trading'),
  ])
    expect(() => dedicatedPaperDatabaseUrl(value, true)).toThrow('UNSAFE_TEST_DATABASE');
  expect(dedicatedPaperDatabaseUrl(url.replace('db:5432', '127.0.0.1:55555'))).toContain('127.0.0.1');
});
