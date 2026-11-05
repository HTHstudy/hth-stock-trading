import { expect, it, vi } from 'vitest';
import * as comparisonWorker from '@hth/worker/backtest-comparison';
import { backtestArtifactSchema, backtestCostPairSchema } from '@hth/contracts';
import type { BacktestArtifact } from '@hth/contracts';
import { contentHash } from '@hth/database';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from './app.js';
import { createAuthenticatedTestApp } from '../test/app.js';
import { createBacktestReports } from './backtest-reports.js';
import { createOwnerAuth, hashOwnerPassword } from './owner-auth.js';
function artifact() {
  const metrics = {
    initialCash: '1000',
    endingCash: '1000',
    endingQuantity: '0',
    endingEquity: '1000',
    netPnl: '0',
    realizedPnl: '0',
    unrealizedPnl: '0',
    cumulativeReturnPct: '0',
    maxDrawdownPct: '0',
    winRatePct: null,
    tradeCount: 0,
    fillCount: 0,
    totalFees: '0',
    totalTax: '0',
  };
  const payload = {
    formatVersion: 'backtest-artifact-v1',
    dataset: { id: null, contentHash: 'a'.repeat(64), source: 'synthetic-demo' },
    report: {
      formatVersion: 'backtest-report-v1',
      engineVersion: '1.0.0',
      mode: 'paper',
      executionEnabled: false,
      model: 'next-eligible-open-v1',
      strategy: { id: 'moving-average-cross', version: '1.0.0', parameters: { fastPeriod: 2, slowPeriod: 3 } },
      config: {
        initialCash: '1000',
        quantity: '1',
        priceTick: '1',
        buyFeeBps: '0',
        sellFeeBps: '0',
        sellTaxBps: '0',
        slippageBps: '0',
      },
      currency: 'KRW',
      datasetRequest: {
        instrument: { market: 'KR', symbol: 'DEMO' },
        interval: '1d',
        adjusted: false,
        from: '2026-03-09',
        to: '2026-03-09',
        source: 'synthetic-demo-v1',
      },
      pointInTime: false,
      warnings: [],
      signals: [],
      fills: [],
      trades: [],
      equity: [
        {
          timestamp: '2026-03-09T00:00:00Z',
          kind: 'initial',
          equity: '1000',
          cash: '1000',
          quantity: '0',
          cumulativeReturnPct: '0',
        },
      ],
      metrics,
    },
  };
  return backtestArtifactSchema.parse({ reportHash: contentHash(payload), ...payload });
}

function higher(left: BacktestArtifact) {
  const value = structuredClone(left);
  value.report.config.buyFeeBps = '1';
  return rehash(value);
}
function rehash(value: BacktestArtifact) {
  const payload = { formatVersion: value.formatVersion, dataset: value.dataset, report: value.report };
  return backtestArtifactSchema.parse({ ...payload, reportHash: contentHash(payload) });
}

const headers = { host: 'localhost:4000' };
const url = (left: string, right: string) => `/v1/backtest-comparison?left=${left}&right=${right}`;
it('requires configured owner, login and server-validated cookie', async () => {
  const left = artifact(),
    right = higher(left);
  const owner = createOwnerAuth(await hashOwnerPassword('synthetic-comparison-password'));
  const disabled = createApp();
  const app = createApp('silent', undefined, undefined, undefined, undefined, owner);
  try {
    expect((await disabled.inject({ url: url(left.reportHash, right.reportHash), headers })).json().error.code).toBe(
      'OWNER_NOT_CONFIGURED',
    );
    expect((await app.inject({ url: url(left.reportHash, right.reportHash), headers })).statusCode).toBe(401);
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { ...headers, 'x-hth-dashboard': '1' },
      payload: { password: 'synthetic-comparison-password' },
    });
    expect(login.statusCode).toBe(200);
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const response = await app.inject({ url: url(left.reportHash, right.reportHash), headers: { ...headers, cookie } });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('BACKTEST_REPORTS_DISABLED');
  } finally {
    await disabled.close();
    await app.close();
  }
});
it('reads only verified fixed-root reports and rejects invalid requests and changed files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hth-cost-pair-'));
  const left = artifact(),
    right = higher(left);
  await writeFile(join(directory, 'left.json'), JSON.stringify(left));
  await writeFile(join(directory, 'right.json'), JSON.stringify(right));
  const different = higher(left);
  different.dataset.contentHash = 'b'.repeat(64);
  const other = rehash(different);
  await writeFile(join(directory, 'different.json'), JSON.stringify(other));
  const store = createBacktestReports(directory);
  const app = createAuthenticatedTestApp('silent', undefined, undefined, store);
  const path = url(left.reportHash, right.reportHash);
  try {
    for (const override of [
      { host: 'public.invalid' },
      { ...headers, origin: 'https://evil.invalid' },
      { ...headers, 'sec-fetch-site': 'cross-site' },
    ])
      expect((await app.inject({ url: path, headers: override })).statusCode).toBe(403);
    expect(
      (
        await app.inject({
          url: path,
          headers: { ...headers, 'x-forwarded-for': '127.0.0.1' },
          remoteAddress: '192.0.2.1',
        })
      ).statusCode,
    ).toBe(403);
    for (const query of [
      '',
      '?left=bad&right=bad',
      `?left=${left.reportHash}`,
      `?left=${left.reportHash}&right=${right.reportHash}&path=private`,
      `?left=${left.reportHash}&left=${right.reportHash}&right=${right.reportHash}`,
    ])
      expect((await app.inject({ url: '/v1/backtest-comparison' + query, headers })).statusCode).toBe(400);
    expect((await app.inject({ url: url(left.reportHash, other.reportHash), headers })).json()).toMatchObject({
      status: 'incomparable',
      reason: 'DIFFERENT_DATASET',
      comparison: null,
    });
    const response = await app.inject({ url: path, headers });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store, private');
    expect(backtestCostPairSchema.parse(response.json()).status).toBe('compared');
    expect((await app.inject({ url: url(right.reportHash, left.reportHash), headers })).json().comparison).toEqual(
      response.json().comparison,
    );
    expect((await app.inject({ url: url(left.reportHash, left.reportHash), headers })).json().reason).toBe(
      'SAME_REPORT',
    );
    expect((await app.inject({ url: url(left.reportHash, 'f'.repeat(64)), headers })).statusCode).toBe(404);
    expect(
      (await app.inject({ method: 'POST', url: path, headers: { ...headers, 'x-hth-dashboard': '1' }, payload: {} }))
        .statusCode,
    ).toBe(404);
    const comparisonFailure = vi.spyOn(comparisonWorker, 'compareBacktestReports').mockImplementationOnce(() => {
      throw new Error('private-internal-error-/private/report.json');
    });
    const unavailable = await app.inject({ url: path, headers });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toEqual({ error: { code: 'BACKTEST_COMPARISON_UNAVAILABLE' } });
    expect(unavailable.body).not.toContain('private-internal-error');
    comparisonFailure.mockRestore();
    // A changed file is re-read even while the directory index is cached.
    right.report.config.quantity = '2';
    await writeFile(join(directory, 'right.json'), JSON.stringify(right));
    expect((await app.inject({ url: path, headers })).statusCode).toBe(404);
    expect(JSON.stringify(response.json())).not.toMatch(/left.json|right.json|dataset|research|validation/);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
