import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { contentHash } from '@hth/database';
import type { createDatabase } from '@hth/database';
import { createPaperPreparationDashboard } from './paper-preparation.js';
import { createApp } from './app.js';
import { createOwnerAuth } from './owner-auth.js';
import { parseApiConfig } from './config.js';
import { createAuthenticatedTestApp, testOwnerHash } from '../test/app.js';

type Snapshot = Awaited<ReturnType<ReturnType<typeof createDatabase>['paperPreparation']['read']>>;
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'paper-preparation-view-'));
  const directory = join(root, 'private');
  const plans = join(root, 'plans');
  await mkdir(directory);
  await mkdir(plans);
  const asOf = new Date().toISOString();
  const entries = [];
  const snapshots = new Map<string, Snapshot>();
  for (const market of ['kr', 'us'] as const) {
    const filename = `paper-market-${market}-validation-v1.json`;
    const plan = JSON.parse(await readFile(new URL(`../../../examples/${filename}`, import.meta.url), 'utf8'));
    await writeFile(join(plans, filename), JSON.stringify(plan));
    const accountId = `paper-market-private-${market}`,
      planHash = contentHash(plan);
    entries.push({ market, accountId, planHash });
    const strategy = {
      accountId,
      strategyId: 'market-ma',
      version: '1.0.0',
      enabled: true,
      revision: 1,
      definition: plan.strategy,
    };
    snapshots.set(accountId, {
      asOf,
      account: {
        id: accountId,
        mode: 'paper',
        dataSource: 'toss-readonly',
        version: 0,
        stopped: true,
        epoch: 0,
        reason: 'PREPARED_OFFLINE',
        limits: plan.limits,
        leaseToken: null,
        leaseUntil: null,
        ledger: {
          cash: plan.cash,
          positions: [],
          observedAt: asOf,
          reconciled: false,
          dailyPnl: {
            KRW: { tradingDate: '2026-10-30', netPnl: '0' },
            USD: { tradingDate: '2026-10-30', netPnl: '0' },
          },
        },
      },
      strategies: [{ ...strategy, definitionHash: contentHash({ version: '1.0.0', definition: plan.strategy }) }],
      revisions: [
        {
          ...strategy,
          actor: 'system',
          createdAt: asOf,
          valueHash: contentHash({ revision: 1, version: '1.0.0', enabled: true, definition: plan.strategy }),
        },
      ],
      receipts: [
        { details: { preparation: 'offline-v1', source: 'toss-readonly', planHash, privateDetail: 'DO_NOT_EXPOSE' } },
      ],
      counts: { orders: '0', fills: '0', reservations: '0' },
    });
  }
  const manifest = { formatVersion: 'paper-preparation-batch-v1', createdAt: asOf, entries };
  await writeFile(join(directory, 'accounts.json'), JSON.stringify(manifest));
  const read = vi.fn(async (id: string) => structuredClone(snapshots.get(id)!));
  const close = vi.fn(async () => {});
  const reader = createPaperPreparationDashboard({ read }, directory, plans, close);
  return {
    root,
    directory,
    plans,
    manifest,
    snapshots,
    read,
    close,
    reader,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
it('양 시장 준비 상태를 공개 DTO로 제한하고 날짜 차이와 이력을 표시한다', async () => {
  const f = await fixture();
  try {
    const report = await f.reader.read();
    expect(report).toMatchObject({
      status: 'ready',
      executionEnabled: false,
      canResume: false,
      marketReadiness: 'not-checked',
    });
    expect(report.accounts).toHaveLength(2);
    for (const item of report.accounts)
      expect(item.details).toMatchObject({
        preparationMatches: true,
        stopped: true,
        leasePresent: false,
        dailyReviewRequired: true,
        clockVerified: true,
      });
    const json = JSON.stringify(report);
    for (const forbidden of [
      'accountId',
      'paper-market-private',
      'leaseToken',
      'DO_NOT_EXPOSE',
      'databaseUrl',
      'request',
      'decision',
    ])
      expect(json).not.toContain(forbidden);
    expect(f.read.mock.calls.map((c) => c[0])).toEqual(['paper-market-private-kr', 'paper-market-private-us']);
  } finally {
    await f.cleanup();
  }
});
it('잘못된 출처·계좌를 공개하지 않고 다른 시장의 결과는 유지한다', async () => {
  const f = await fixture();
  try {
    f.snapshots.get('paper-market-private-kr')!.account.dataSource = 'synthetic-only';
    const r = await f.reader.read();
    expect(r.status).toBe('unavailable');
    expect(r.accounts[0]).toEqual({ market: 'KR', status: 'unavailable', details: null });
    expect(r.accounts[1]!.status).toBe('available');
  } finally {
    await f.cleanup();
  }
});
it('계획 변경·hash 불일치를 기본 설정으로 대체하지 않는다', async () => {
  const f = await fixture();
  try {
    const file = join(f.plans, 'paper-market-kr-validation-v1.json');
    const plan = JSON.parse(await readFile(file, 'utf8'));
    plan.strategy.quantity = '2';
    await writeFile(file, JSON.stringify(plan));
    const r = await f.reader.read();
    expect(r.accounts[0]!.status).toBe('unavailable');
    expect(f.read).toHaveBeenCalledTimes(1);
  } finally {
    await f.cleanup();
  }
});
it('중복 대상·symlink·큰 설정 파일은 DB 조회 전에 거부한다', async () => {
  for (const kind of ['duplicate', 'symlink', 'oversize']) {
    const f = await fixture();
    try {
      const path = join(f.directory, 'accounts.json');
      if (kind === 'duplicate') {
        f.manifest.entries[1]!.accountId = f.manifest.entries[0]!.accountId;
        await writeFile(path, JSON.stringify(f.manifest));
      }
      if (kind === 'symlink') {
        await writeFile(join(f.root, 'other.json'), JSON.stringify(f.manifest));
        await rm(path);
        await symlink(join(f.root, 'other.json'), path);
      }
      if (kind === 'oversize') await writeFile(path, ' '.repeat(65537));
      expect(await f.reader.read()).toMatchObject({ status: 'unavailable', accounts: [] });
      expect(f.read).not.toHaveBeenCalled();
    } finally {
      await f.cleanup();
    }
  }
});
it('DB 시각이 미래이면 날짜 검토를 확정하지 않고 설정 변경을 숨기지 않는다', async () => {
  const f = await fixture();
  try {
    const snapshot = f.snapshots.get('paper-market-private-kr')!;
    snapshot.asOf = new Date(Date.now() + 60000).toISOString();
    snapshot.account.stopped = false;
    const r = await f.reader.read();
    expect(r.accounts[0]!.details).toMatchObject({
      clockVerified: false,
      dailyReviewRequired: null,
      stopped: false,
      preparationMatches: false,
    });
  } finally {
    await f.cleanup();
  }
});
it('기본 비활성·소유자·localhost·입력 경계를 유지하며 GET만 제공한다', async () => {
  const f = await fixture();
  const args = [
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    f.reader,
  ] as const;
  const app = createAuthenticatedTestApp(...args);
  const headers = { host: 'localhost:4000' };
  try {
    expect((await app.inject({ method: 'GET', url: '/v1/paper/preparation', headers })).statusCode).toBe(200);
    const calls = f.read.mock.calls.length;
    for (const query of ['accountId=private', 'path=/tmp/a', 'market=US'])
      expect((await app.inject({ method: 'GET', url: '/v1/paper/preparation?' + query, headers })).statusCode).toBe(
        400,
      );
    expect(
      (await app.inject({ method: 'GET', url: '/v1/paper/preparation', headers, remoteAddress: '203.0.113.5' }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/paper/preparation',
          headers: { ...headers, 'x-hth-dashboard': '1' },
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
    expect(f.read).toHaveBeenCalledTimes(calls);
  } finally {
    await app.close();
    await f.cleanup();
  }
  expect(f.close).toHaveBeenCalledTimes(1);
  const disabled = createAuthenticatedTestApp();
  expect((await disabled.inject({ method: 'GET', url: '/v1/paper/preparation', headers })).json()).toMatchObject({
    status: 'disabled',
    accounts: [],
  });
  await disabled.close();
  const anonymous = createApp('silent', undefined, undefined, undefined, undefined, createOwnerAuth(testOwnerHash));
  expect((await anonymous.inject({ method: 'GET', url: '/v1/paper/preparation', headers })).statusCode).toBe(401);
  await anonymous.close();
});
it('준비 조회 활성화에는 소유자·loopback·전용 DB 설정이 필요하다', () => {
  expect(parseApiConfig({}).PAPER_PREPARATION_ENABLED).toBe(false);
  const base = {
    PAPER_PREPARATION_ENABLED: 'true',
    PAPER_PREPARATION_DATABASE_URL: 'postgresql://hth_test:fake@localhost:55434/hth_readonly_test',
    OWNER_PASSWORD_HASH: testOwnerHash,
  };
  expect(parseApiConfig(base).PAPER_PREPARATION_ENABLED).toBe(true);
  for (const patch of [
    { OWNER_PASSWORD_HASH: '' },
    { API_HOST: '0.0.0.0' },
    { NODE_ENV: 'production' },
    { PAPER_PREPARATION_DATABASE_URL: 'postgresql://user:fake@remote/business' },
  ])
    expect(() => parseApiConfig({ ...base, ...patch })).toThrow();
});
