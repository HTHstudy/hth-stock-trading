import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, expect, it, vi } from 'vitest';
import { strategyResearchSnapshotSchema } from '@hth/contracts';
import { contentHash } from '@hth/database';
import { createApp } from './app.js';
import { createOwnerAuth, hashOwnerPassword } from './owner-auth.js';
import { createStrategyResearchReader } from './strategy-research.js';
import type { StrategyResearchReader } from './strategy-research.js';

function snapshot(seed = 'a') {
  const payload = {
    formatVersion: 'strategy-research-snapshot-v1',
    sourceResultHash: seed.repeat(64),
    manifestHash: 'b'.repeat(64),
    legacyStudyResultHash: 'c'.repeat(64),
    mode: 'paper',
    executionEnabled: false,
    pointInTime: false,
    independentHoldoutVerified: false,
    strategySelected: false,
    artifactIntegrityVerified: true,
    datasetFilesReverified: false,
    engineReexecuted: false,
    benchmark: { entryAfterClosedCandles: 3 },
    datasets: [
      {
        id: 'test',
        role: 'research',
        request: {
          instrument: { market: 'KR', symbol: 'DEMO' },
          interval: '1d',
          adjusted: false,
          from: '2026-03-09',
          to: '2026-03-10',
          source: 'synthetic-demo-v1',
        },
      },
    ],
    rows: [
      {
        dataset: 'test',
        variant: 'benchmark',
        kind: 'benchmark',
        strategy: { id: 'buy-and-hold', version: '1.0.0', parameters: { entryAfterClosedCandles: 3 } },
        execution: {
          initialCash: '1000',
          quantity: '1',
          priceTick: '1',
          buyFeeBps: '0',
          sellFeeBps: '0',
          sellTaxBps: '0',
          slippageBps: '0',
        },
        reportHash: 'd'.repeat(64),
        tradePathObserved: false,
        warmupSignals: 0,
        unfilledAtEnd: 0,
        metrics: {
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
        },
        exposure: {
          model: 'acquisition-cost-calendar-time-v1',
          windowStartAt: '2026-03-09T00:00:00Z',
          windowEndAt: '2026-03-10T00:00:00Z',
          windowMilliseconds: 86400000,
          holdingMilliseconds: 0,
          holdingPct: '0',
          maxInvestedCapital: '0',
          averageInvestedCapital: '0',
          netPnlOverMaxInvestedCapitalPct: null,
          totalBuyNotional: '0',
          totalSellNotional: '0',
        },
        comparisonStatus: 'benchmark',
        benchmarkReportHash: null,
        netPnlDifference: null,
      },
    ],
  };
  const completePayload = {
    ...payload,
    rows: [
      ...payload.rows,
      {
        ...payload.rows[0]!,
        variant: 'moving-average',
        kind: 'strategy',
        strategy: { id: 'moving-average-cross', version: '1.0.0', parameters: { fastPeriod: 2, slowPeriod: 3 } },
        reportHash: 'e'.repeat(64),
        comparisonStatus: 'strategy-no-fills',
        benchmarkReportHash: 'd'.repeat(64),
      },
    ],
  };
  return strategyResearchSnapshotSchema.parse({ ...completePayload, snapshotHash: contentHash(completePayload) });
}

const password = 'synthetic-test-owner-password-only';
const headers = { host: 'localhost:4000', 'x-hth-dashboard': '1' };
let ownerHash: string;
beforeAll(async () => {
  ownerHash = await hashOwnerPassword(password);
}, 10_000);
function appWith(reader?: StrategyResearchReader, configured = true) {
  const args: Parameters<typeof createApp> = [];
  args[5] = configured ? createOwnerAuth(ownerHash) : undefined;
  args[11] = reader;
  return createApp(...args);
}
async function login(app: ReturnType<typeof createApp>) {
  const response = await app.inject({ method: 'POST', url: '/v1/auth/login', headers, payload: { password } });
  expect(response.statusCode).toBe(200);
  return { ...headers, cookie: String(response.headers['set-cookie']).split(';')[0]! };
}

it('실제 cookie 로그인과 localhost 경계를 목록·상세에 적용한다', async () => {
  const data = snapshot();
  const reader = {
    list: vi.fn(async () => ({ reports: [], rejectedCount: 0, limited: false })),
    get: vi.fn(async () => data),
  };
  const app = appWith(reader);
  const unconfigured = appWith(reader, false);
  try {
    for (const url of ['/v1/strategy-research', `/v1/strategy-research/${data.snapshotHash}`]) {
      expect((await unconfigured.inject({ url, headers })).statusCode).toBe(503);
      expect((await app.inject({ url, headers })).statusCode).toBe(401);
      expect((await app.inject({ url, headers: { ...headers, authorization: 'Bearer forged' } })).statusCode).toBe(401);
    }
    expect(reader.list).not.toHaveBeenCalled();
    expect(reader.get).not.toHaveBeenCalled();
    const signed = await login(app);
    for (const url of ['/v1/strategy-research', `/v1/strategy-research/${data.snapshotHash}`]) {
      for (const extra of [
        { origin: 'https://outside.example' },
        { host: 'outside.example' },
        { 'sec-fetch-site': 'cross-site' },
      ]) {
        expect((await app.inject({ url, headers: { ...signed, ...extra } })).statusCode).toBe(403);
      }
      expect((await app.inject({ url, headers: signed, remoteAddress: '192.0.2.1' })).statusCode).toBe(403);
      expect(
        (await app.inject({ url, headers: { ...signed, 'x-forwarded-for': '127.0.0.1' }, remoteAddress: '192.0.2.1' }))
          .statusCode,
      ).toBe(403);
      const response = await app.inject({ url, headers: signed });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store, private');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      for (const query of ['path=../../secret', 'format=markdown', 'run=true', 'hash=a', 'unknown='])
        expect((await app.inject({ url: `${url}?${query}`, headers: signed })).statusCode).toBe(400);
      for (const method of ['POST', 'PUT', 'DELETE', 'HEAD'] as const)
        expect(
          (await app.inject({ method, url, headers: signed, ...(method === 'HEAD' ? {} : { payload: {} }) }))
            .statusCode,
        ).toBe(404);
    }
    expect(reader.list).toHaveBeenCalledOnce();
    expect(reader.get).toHaveBeenCalledOnce();
    expect((await app.inject({ url: '/v1/strategy-research/INVALID', headers: signed })).statusCode).toBe(400);
    expect((await app.inject({ url: `/v1/strategy-research/${'A'.repeat(64)}`, headers: signed })).statusCode).toBe(
      400,
    );
    await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: signed, payload: {} });
    expect((await app.inject({ url: '/v1/strategy-research', headers: signed })).statusCode).toBe(401);
  } finally {
    await Promise.all([app.close(), unconfigured.close()]);
  }
});

it('읽기 전용 파일 목록 뒤 변조·삭제된 상세는 새 검증으로 404를 반환한다', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hth-research-routes-'));
  const data = snapshot();
  const path = join(directory, `${data.snapshotHash}.json`);
  await writeFile(path, JSON.stringify(data));
  const app = appWith(createStrategyResearchReader(directory));
  try {
    const signed = await login(app);
    const list = await app.inject({ url: '/v1/strategy-research', headers: signed });
    expect(list.statusCode).toBe(200);
    expect(list.json().reports[0].snapshotHash).toBe(data.snapshotHash);
    const url = `/v1/strategy-research/${data.snapshotHash}`;
    expect((await app.inject({ url, headers: signed })).json()).toEqual(data);
    await writeFile(path, JSON.stringify({ ...data, manifestHash: 'e'.repeat(64) }));
    expect((await app.inject({ url, headers: signed })).statusCode).toBe(404);
    await rm(path);
    const response = await app.inject({ url, headers: signed });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toMatch(/ENOENT|snapshotHash|\/|PID/);
    expect((await app.inject({ url: `/v1/strategy-research/${'0'.repeat(64)}`, headers: signed })).statusCode).toBe(
      404,
    );
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('미구성·조회 오류·알 수 없는 응답 필드는 안전한 코드로 처리한다', async () => {
  const data = snapshot();
  const readers: (StrategyResearchReader | undefined)[] = [
    undefined,
    {
      list: async () => {
        throw new Error('/private/PID/raw-secret');
      },
      get: async () => {
        throw new Error('/private/PID/raw-secret');
      },
    },
    {
      list: async () => ({ reports: [], rejectedCount: 0, limited: false, secret: 'raw-secret' }),
      get: async () => ({ ...data, secret: 'raw-secret' }),
    },
    {
      list: async () => ({
        reports: [
          {
            snapshotHash: data.snapshotHash,
            sourceResultHash: data.sourceResultHash,
            instrument: { market: 'KR', symbol: 'DEMO' },
            interval: '1d',
            currency: 'KRW',
            periods: 1,
            rows: 1,
            secret: 'raw-secret',
          },
        ],
        rejectedCount: 0,
        limited: false,
      }),
      get: async () => snapshot('f'),
    },
  ];
  for (const [index, reader] of readers.entries()) {
    const app = appWith(reader);
    try {
      const signed = await login(app);
      for (const url of ['/v1/strategy-research', `/v1/strategy-research/${data.snapshotHash}`]) {
        const response = await app.inject({ url, headers: signed });
        expect(response.statusCode).toBe(index === 1 && url.endsWith(data.snapshotHash) ? 404 : 503);
        expect(response.body).not.toMatch(/private|PID|raw-secret|ENOENT/);
      }
    } finally {
      await app.close();
    }
  }
});
