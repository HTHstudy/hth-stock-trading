import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { createWatchlistStore, environmentWatchlist } from './watchlist-store.js';
import { createAuthenticatedTestApp } from '../test/app.js';
import { createApp } from './app.js';
import { createDashboardService } from './dashboard-service.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'hth-watchlist-'));
  roots.push(root);
  const directory = join(root, 'settings');
  const initial = environmentWatchlist(undefined);
  return { root, directory, initial, store: createWatchlistStore(directory, initial) };
}
it('첫 조회는 파일을 만들지 않고 서버 기본값을 제공한다', async () => {
  const context = await fixture();
  expect(await context.store.read()).toEqual({ revision: 0, origin: 'environment', instruments: context.initial });
  expect(await readdir(context.root)).toEqual([]);
});
it('정규화한 종목과 빈 목록을 영속화하고 재시작 시 기본값으로 되돌리지 않는다', async () => {
  const context = await fixture();
  expect(
    await context.store.save({ expectedRevision: 0, instruments: [{ market: 'US', symbol: ' aapl ' }] }),
  ).toMatchObject({ revision: 1, origin: 'saved', instruments: [{ market: 'US', symbol: 'AAPL' }] });
  const restarted = createWatchlistStore(context.directory, context.initial);
  expect((await restarted.read()).revision).toBe(1);
  await restarted.save({ expectedRevision: 1, instruments: [] });
  expect(await createWatchlistStore(context.directory, context.initial).read()).toEqual({
    revision: 2,
    origin: 'saved',
    instruments: [],
  });
  expect((await stat(context.directory)).mode & 0o777).toBe(0o700);
  expect((await stat(join(context.directory, 'watchlist.json'))).mode & 0o777).toBe(0o600);
  expect(await readdir(context.directory)).toEqual(['watchlist.json']);
});
it('여러 작성자의 동시 저장과 오래된 리비전은 덮어쓰지 않는다', async () => {
  const context = await fixture();
  const other = createWatchlistStore(context.directory, context.initial);
  const results = await Promise.allSettled([
    context.store.save({ expectedRevision: 0, instruments: [] }),
    other.save({ expectedRevision: 0, instruments: [{ market: 'US', symbol: 'MSFT' }] }),
  ]);
  expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
  expect((await context.store.read()).revision).toBe(1);
  await expect(context.store.save({ expectedRevision: 0, instruments: context.initial })).rejects.toThrow(
    'WATCHLIST_REVISION_CONFLICT',
  );
});
it('중복·과대 목록·추가 실행/계좌 입력을 파일 생성 전에 거부한다', async () => {
  const context = await fixture();
  for (const value of [
    {
      expectedRevision: 0,
      instruments: [
        { market: 'US', symbol: 'aapl' },
        { market: 'US', symbol: ' AAPL ' },
      ],
    },
    { expectedRevision: 0, instruments: Array.from({ length: 21 }, (_, i) => ({ market: 'US', symbol: `S${i}` })) },
    { expectedRevision: 0, instruments: [], resume: true },
    { expectedRevision: 0, instruments: [{ market: 'US', symbol: 'AAPL', accountId: 'PRIVATE' }] },
  ])
    await expect(context.store.save(value)).rejects.toThrow();
  expect(await readdir(context.root)).toEqual([]);
});
it('손상·심볼릭 링크 파일은 기본값으로 숨기지 않고 실패한다', async () => {
  const context = await fixture();
  await context.store.save({ expectedRevision: 0, instruments: [] });
  const path = join(context.directory, 'watchlist.json');
  await writeFile(path, 'PRIVATE_BROKEN_DATA');
  await expect(context.store.read()).rejects.toThrow(/^WATCHLIST_UNAVAILABLE$/);
  await rm(path);
  await symlink(join(context.root, 'not-present'), path);
  await expect(context.store.read()).rejects.toThrow(/^WATCHLIST_UNAVAILABLE$/);
});
it('남은 잠금은 자동으로 제거하지 않으며 현재 설정을 보존한다', async () => {
  const context = await fixture();
  await context.store.save({ expectedRevision: 0, instruments: [] });
  await writeFile(join(context.directory, 'watchlist.lock'), 'stale');
  await expect(context.store.save({ expectedRevision: 1, instruments: context.initial })).rejects.toThrow(
    'WATCHLIST_BUSY',
  );
  expect((await context.store.read()).revision).toBe(1);
  expect(await readFile(join(context.directory, 'watchlist.lock'), 'utf8')).toBe('stale');
});
it('인증·CSRF·입력 경계를 지키고 저장은 시세 수집을 실행하지 않는다', async () => {
  const context = await fixture();
  const load = vi.fn(async () => {
    throw new Error('SHOULD_NOT_LOAD');
  });
  const dashboard = createDashboardService({ enabled: true, configured: true, load });
  const app = createAuthenticatedTestApp(
    'silent',
    dashboard,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    context.store,
  );
  const privateApp = createApp(
    'silent',
    undefined,
    undefined,
    undefined,
    undefined,
    {
      read: () => ({ configured: true, authenticated: false, expiresAt: null }),
      login: async () => {
        throw new Error('UNUSED');
      },
      logout: () => '',
      close: () => {},
    },
    undefined,
    context.store,
  );
  const headers = { host: 'localhost:4000', 'x-hth-dashboard': '1' };
  try {
    expect((await privateApp.inject({ method: 'GET', url: '/v1/watchlist', headers })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/watchlist',
          headers: { host: 'localhost:4000' },
          payload: { expectedRevision: 0, instruments: [] },
        })
      ).statusCode,
    ).toBe(403);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/watchlist',
      headers,
      payload: { expectedRevision: 0, instruments: [] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store, private');
    expect(response.json()).toMatchObject({ revision: 1, instruments: [] });
    expect(load).not.toHaveBeenCalled();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/watchlist',
          headers,
          payload: { expectedRevision: 0, instruments: [] },
        })
      ).statusCode,
    ).toBe(409);
    expect((await app.inject({ method: 'GET', url: '/v1/watchlist?path=private', headers })).statusCode).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/watchlist',
          headers,
          payload: { expectedRevision: 1, instruments: [], resume: true },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/v1/watchlist',
          headers: { ...headers, origin: 'https://evil.invalid' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ method: 'GET', url: '/v1/watchlist', headers, remoteAddress: '192.0.2.1' })).statusCode,
    ).toBe(403);
  } finally {
    await app.close();
    await privateApp.close();
  }
});
