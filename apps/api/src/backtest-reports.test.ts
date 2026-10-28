import { mkdtemp, open, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { backtestArtifactSchema } from '@hth/contracts';
import { contentHash } from '@hth/database';
import { createBacktestReports } from './backtest-reports.js';
import { createApp } from './app.js';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'hth-report-view-'));
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
  const artifact = backtestArtifactSchema.parse({ reportHash: contentHash(payload), ...payload });
  return { directory, artifact };
}
it('목록은 검증한 hash만 제공하고 변조·미지원 JSON·symlink를 제외한다', async () => {
  const { directory, artifact } = await fixture();
  try {
    await writeFile(join(directory, 'valid.json'), JSON.stringify(artifact));
    await writeFile(join(directory, 'duplicate.json'), JSON.stringify(artifact));
    await writeFile(join(directory, 'changed.json'), JSON.stringify({ ...artifact, reportHash: '0'.repeat(64) }));
    await writeFile(join(directory, 'private.json'), JSON.stringify({ token: 'secret-value' }));
    await symlink(join(directory, 'valid.json'), join(directory, 'link.json'));
    const store = createBacktestReports(directory);
    const list = await store.list();
    expect(list.reports).toHaveLength(1);
    expect(list.rejectedCount).toBe(2);
    expect(JSON.stringify(list)).not.toMatch(/secret-value|valid.json|private.json/);
    expect(await store.get(artifact.reportHash)).toEqual(artifact);
    await expect(store.get('../private.json')).rejects.toThrow('INVALID_REPORT_ID');
    await writeFile(join(directory, 'valid.json'), '{}');
    await writeFile(join(directory, 'duplicate.json'), '{}');
    await expect(store.get(artifact.reportHash)).rejects.toThrow('REPORT_NOT_FOUND');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
it('리포트 API는 로컬 경계를 유지하고 경로 입력·생성 요청을 거부한다', async () => {
  const { directory, artifact } = await fixture();
  await writeFile(join(directory, 'valid.json'), JSON.stringify(artifact));
  const app = createApp('silent', undefined, undefined, createBacktestReports(directory));
  try {
    const headers = { host: 'localhost:4000' };
    for (const path of ['/v1/backtests', `/v1/backtests/${artifact.reportHash}`]) {
      expect(
        (await app.inject({ url: path, headers: { ...headers, origin: 'https://attacker.invalid' } })).statusCode,
      ).toBe(403);
      expect((await app.inject({ url: path, headers, remoteAddress: '192.0.2.1' })).statusCode).toBe(403);
      const response = await app.inject({ url: path, headers });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store, private');
    }
    expect((await app.inject({ url: '/v1/backtests/not-a-hash', headers })).statusCode).toBe(400);
    expect((await app.inject({ url: `/v1/backtests/${'a'.repeat(64)}`, headers })).statusCode).toBe(404);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/backtests',
          headers: { ...headers, 'x-hth-dashboard': '1' },
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
    const { reportHash, ...payload } = artifact;
    expect(contentHash(payload)).toBe(reportHash);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
it('디렉터리 부재는 빈 목록이고 비활성 API는 503이다', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hth-report-empty-'));
  await rm(directory, { recursive: true, force: true });
  expect(await createBacktestReports(directory).list()).toEqual({ reports: [], rejectedCount: 0, limited: false });
  const app = createApp();
  try {
    expect((await app.inject({ url: '/v1/backtests', headers: { host: 'localhost:4000' } })).statusCode).toBe(503);
  } finally {
    await app.close();
  }
});
it('파일 수와 파일 크기 상한을 적용하고 디렉터리 symlink를 따라가지 않는다', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hth-report-limits-'));
  try {
    const file = await open(join(directory, 'oversized.json'), 'w');
    try {
      await file.truncate(32 * 1_048_576 + 1);
    } finally {
      await file.close();
    }
    expect((await createBacktestReports(directory).list()).rejectedCount).toBe(1);
    const alias = join(directory, 'alias');
    await symlink(directory, alias);
    await expect(createBacktestReports(alias).list()).rejects.toThrow('REPORT_DIRECTORY_UNAVAILABLE');
    await Promise.all(Array.from({ length: 101 }, (_, index) => writeFile(join(directory, `${index}.json`), '{}')));
    expect((await createBacktestReports(directory).list()).limited).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
