import { mkdtemp, open, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { strategyResearchSnapshotSchema } from '@hth/contracts';
import { contentHash } from '@hth/database';
import { createStrategyResearchReader } from './strategy-research.js';

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

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'hth-research-'));
  directories.push(directory);
  const data = snapshot();
  const path = join(directory, `${data.snapshotHash}.json`);
  await writeFile(path, JSON.stringify(data));
  return { directory, data, path, reader: createStrategyResearchReader(directory) };
}

it('새 형식 전체 payload 해시와 파일명을 검증하고 사전 계산 행만 반환한다', async () => {
  const { directory, reader, data } = await fixture();
  const list = await reader.list();
  expect(list).toEqual({
    reports: [
      {
        snapshotHash: data.snapshotHash,
        sourceResultHash: data.sourceResultHash,
        instrument: { market: 'KR', symbol: 'DEMO' },
        interval: '1d',
        currency: 'KRW',
        periods: 1,
        rows: 2,
      },
    ],
    rejectedCount: 0,
    limited: false,
  });
  expect(await reader.get(data.snapshotHash)).toEqual(data);
  expect(JSON.stringify(list)).not.toContain(directory);
  await writeFile(join(directory, `${'0'.repeat(64)}.json`), JSON.stringify(data));
  await writeFile(join(directory, 'arbitrary.json'), JSON.stringify(data));
  await writeFile(join(directory, 'notes.md'), 'private markdown');
  expect((await reader.list()).rejectedCount).toBe(2);
  await expect(reader.get('../notes.md')).rejects.toThrow('INVALID_RESEARCH_ID');
});

it.each(['sourceResultHash', 'manifestHash', 'legacyStudyResultHash'])(
  '메타데이터 %s 변조도 거부한다',
  async (field) => {
    const { reader, path, data } = await fixture();
    await writeFile(path, JSON.stringify({ ...data, [field]: 'f'.repeat(64) }));
    expect(await reader.list()).toEqual({ reports: [], rejectedCount: 1, limited: false });
    await expect(reader.get(data.snapshotHash)).rejects.toThrow('STRATEGY_RESEARCH_NOT_FOUND');
  },
);

it('알 수 없는 필드·잘못된 schema·삭제·늦은 변경을 캐시 없이 거부한다', async () => {
  const { reader, path, data } = await fixture();
  await reader.list();
  for (const invalid of [
    { ...data, privatePath: '/private/secret' },
    { ...data, rows: [] },
    { ...data, snapshotHash: 'e'.repeat(64) },
    { token: 'PRIVATE' },
  ]) {
    await writeFile(path, JSON.stringify(invalid));
    await expect(reader.get(data.snapshotHash)).rejects.toThrow('STRATEGY_RESEARCH_NOT_FOUND');
    expect((await reader.list()).rejectedCount).toBe(1);
  }
  await rm(path);
  await expect(reader.get(data.snapshotHash)).rejects.toThrow('STRATEGY_RESEARCH_NOT_FOUND');
  expect((await reader.list()).reports).toEqual([]);
});

it('빈 root와 없는 root는 빈 목록이고 root/file symlink는 따라가지 않는다', async () => {
  const { directory, reader, path, data } = await fixture();
  const alias = `${directory}-alias`;
  directories.push(alias);
  await symlink(directory, alias);
  await expect(createStrategyResearchReader(alias).list()).rejects.toThrow('STRATEGY_RESEARCH_UNAVAILABLE');
  await expect(createStrategyResearchReader(alias).get(data.snapshotHash)).rejects.toThrow(
    'STRATEGY_RESEARCH_NOT_FOUND',
  );
  const target = join(directory, 'target');
  await writeFile(target, JSON.stringify(data));
  await rm(path);
  await symlink(target, path);
  expect((await reader.list()).rejectedCount).toBe(1);
  await expect(reader.get(data.snapshotHash)).rejects.toThrow('STRATEGY_RESEARCH_NOT_FOUND');
  await rm(directory, { recursive: true });
  expect(await reader.list()).toEqual({ reports: [], rejectedCount: 0, limited: false });
  await expect(reader.get(data.snapshotHash)).rejects.toThrow('STRATEGY_RESEARCH_NOT_FOUND');
});

it('파일 1MiB와 전체 16MiB·100개 스캔 상한은 실패한 JSON에도 적용된다', async () => {
  const { directory, reader, path, data } = await fixture();
  const file = await open(path, 'w');
  await file.truncate(1_048_577);
  await file.close();
  expect((await reader.list()).rejectedCount).toBe(1);
  await expect(reader.get(data.snapshotHash)).rejects.toThrow('STRATEGY_RESEARCH_NOT_FOUND');
  await rm(path);
  for (let i = 0; i < 17; i++)
    await writeFile(join(directory, `${i.toString(16).padStart(64, '0')}.json`), Buffer.alloc(1_048_575));
  expect(await reader.list()).toEqual({ reports: [], rejectedCount: 16, limited: true });
  await rm(directory, { recursive: true });
  const fresh = await fixture();
  await rm(fresh.path);
  await Promise.all(Array.from({ length: 101 }, (_, i) => writeFile(join(fresh.directory, `entry-${i}`), '')));
  expect(await fresh.reader.list()).toEqual({ reports: [], rejectedCount: 0, limited: true });
});

it('열린 파일이 읽는 도중 커지면 거부한다', async () => {
  const { reader, path, data } = await fixture();
  const handle = await open(path, 'r');
  const prototype = Object.getPrototypeOf(handle) as { read: typeof handle.read };
  await handle.close();
  const original = prototype.read;
  let changed = false;
  vi.spyOn(prototype, 'read').mockImplementation(async function (
    this: typeof handle,
    ...args: Parameters<typeof handle.read>
  ) {
    if (!changed) {
      changed = true;
      await writeFile(path, `${JSON.stringify(data)} `);
    }
    return Reflect.apply(original, this, args);
  });
  await expect(reader.get(data.snapshotHash)).rejects.toThrow('STRATEGY_RESEARCH_NOT_FOUND');
  expect(changed).toBe(true);
});
