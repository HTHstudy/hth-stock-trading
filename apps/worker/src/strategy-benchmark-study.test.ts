import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { contentHash } from '@hth/database';
import { strategyResearchSnapshotSchema } from '@hth/contracts';
import { createBacktestDemo } from './backtest-demo.js';
import { parseStrategyResearchSnapshot } from './strategy-research-snapshot.js';
import { parseStrategyStudyManifest, runStrategyStudy } from './strategy-study.js';
import {
  createStrategyResearchSnapshot,
  parseStrategyBenchmarkManifest,
  reviewStrategyBenchmarkStudy,
  runStrategyBenchmarkStudy,
} from './strategy-benchmark-study.js';

function fixture() {
  const dataset = createBacktestDemo();
  const exported = { id: randomUUID(), contentHash: contentHash(dataset), dataset };
  const execution = {
    initialCash: '10000',
    quantity: '1',
    priceTick: '1',
    buyFeeBps: '10',
    sellFeeBps: '30',
    sellTaxBps: '0',
    slippageBps: '5',
  };
  const study = parseStrategyStudyManifest({
    formatVersion: 'strategy-study-v1',
    purpose: 'exploratory-comparison',
    datasets: [
      {
        id: 'march',
        path: 'input.json',
        role: 'research',
        contentHash: exported.contentHash,
        request: dataset.request,
      },
    ],
    variants: [
      {
        id: 'ma',
        strategy: { id: 'moving-average-cross', version: '1.0.0', parameters: { fastPeriod: 3, slowPeriod: 5 } },
        execution,
      },
      {
        id: 'breakout',
        strategy: { id: 'channel-breakout', version: '1.0.0', parameters: { entryPeriod: 5, exitPeriod: 2 } },
        execution,
      },
      {
        id: 'reversion',
        strategy: { id: 'mean-reversion', version: '1.0.0', parameters: { period: 5, entryDeviationBps: '100' } },
        execution,
      },
    ],
  });
  const manifest = parseStrategyBenchmarkManifest({
    formatVersion: 'strategy-benchmark-study-v1',
    study,
    benchmark: { entryAfterClosedCandles: 6 },
    exposureModel: 'acquisition-cost-calendar-time-v1',
  });
  return { exported, manifest };
}
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
function rehash(result: ReturnType<typeof runStrategyBenchmarkStudy>) {
  const { resultHash, ...payload } = result;
  expect(resultHash).toMatch(/^[a-f0-9]{64}$/);
  return { ...payload, resultHash: contentHash(payload) };
}
it('기존 연구 결과 hash를 유지하고 동일 비용당 단일 보유 대조군만 실행한다', () => {
  const { exported, manifest } = fixture();
  const prior = runStrategyStudy(manifest.study, [exported]);
  const result = runStrategyBenchmarkStudy(manifest, [exported]);
  expect(result.study).toEqual(prior);
  expect(runStrategyBenchmarkStudy(manifest, [exported])).toEqual(result);
  expect(result.benchmarks).toHaveLength(1);
  const report = result.benchmarks[0]!.artifact.report;
  expect(report.fills).toHaveLength(1);
  expect(report.fills[0]!.action).toBe('BUY');
  expect(report.fills[0]!.signalIndex).toBe(5);
  expect(Date.parse(report.fills[0]!.timestamp)).toBeGreaterThan(Date.parse(report.signals[5]!.evaluatedAt));
  expect(report.metrics.endingQuantity).toBe('1');
  expect(report.metrics.tradeCount).toBe(0);
  expect(result.exposures).toHaveLength(4);
});
it('snapshot은 취득원가·달력시간·동일 대조군 차이를 보존하고 원본/경로를 내보내지 않는다', () => {
  const { exported, manifest } = fixture();
  const result = runStrategyBenchmarkStudy(manifest, [exported]);
  const snapshot = createStrategyResearchSnapshot(result, manifest);
  expect(snapshot.rows).toHaveLength(4);
  expect(snapshot).toMatchObject({
    datasetFilesReverified: false,
    engineReexecuted: false,
    independentHoldoutVerified: false,
    strategySelected: false,
    executionEnabled: false,
  });
  const { snapshotHash, ...payload } = snapshot;
  expect(contentHash(payload)).toBe(snapshotHash);
  expect(JSON.stringify(snapshot)).not.toContain('input.json');
  expect(JSON.stringify(snapshot)).not.toContain(exported.id);
  for (const row of snapshot.rows) {
    expect(row.exposure.model).toBe('acquisition-cost-calendar-time-v1');
    expect(row.exposure.holdingMilliseconds).toBeLessThanOrEqual(row.exposure.windowMilliseconds);
    if (row.kind === 'strategy' && row.tradePathObserved) {
      expect(row.comparisonStatus).toBe('compared');
      expect(row.benchmarkReportHash).toBe(result.benchmarks[0]!.artifact.reportHash);
      expect(row.netPnlDifference).not.toBeNull();
    }
  }
});
it('비용 조건이 다르면 대조군을 나누고 전체 실행 상한·첫 판단 시점 불일치를 거부한다', () => {
  const { exported, manifest } = fixture();
  const changed = structuredClone(manifest);
  changed.study.variants[1]!.execution.buyFeeBps = '20';
  expect(runStrategyBenchmarkStudy(changed, [exported]).benchmarks).toHaveLength(2);
  for (const bad of [
    { ...manifest, benchmark: { entryAfterClosedCandles: 5 } },
    { ...manifest, restart: true },
    {
      ...manifest,
      study: {
        ...manifest.study,
        variants: [manifest.study.variants[0], { ...manifest.study.variants[0], id: 'duplicate-conditions' }],
      },
    },
    {
      ...manifest,
      study: {
        ...changed.study,
        datasets: Array.from({ length: 8 }, (_, i) => ({ ...manifest.study.datasets[0], id: `d-${i}` })),
      },
    },
  ])
    expect(() => parseStrategyBenchmarkManifest(bad)).toThrow('INVALID_STRATEGY_BENCHMARK_MANIFEST');
});
it('아직 진입할 수 없는 기간에는 0체결·투자 없음·비교 미검증을 유지한다', () => {
  const { exported, manifest } = fixture();
  manifest.study.variants = [
    {
      id: 'long-warmup',
      strategy: { id: 'channel-breakout', version: '1.0.0', parameters: { entryPeriod: 40, exitPeriod: 10 } },
      execution: manifest.study.variants[0]!.execution,
    },
  ];
  manifest.benchmark.entryAfterClosedCandles = 41;
  const snapshot = createStrategyResearchSnapshot(runStrategyBenchmarkStudy(manifest, [exported]), manifest);
  expect(snapshot.rows[0]).toMatchObject({
    tradePathObserved: false,
    comparisonStatus: 'strategy-no-fills',
    netPnlDifference: null,
    exposure: { maxInvestedCapital: '0', holdingMilliseconds: 0, netPnlOverMaxInvestedCapitalPct: null },
  });
  expect(snapshot.rows[1]!.tradePathObserved).toBe(false);
});
it('hash 재계산으로 취득원가·보유시간·누락/중복 대조군·비용 연결 검사를 우회하지 않는다', () => {
  const { exported, manifest } = fixture();
  const original = runStrategyBenchmarkStudy(manifest, [exported]);
  const changes: Array<(result: typeof original) => void> = [
    (result) => {
      result.exposures[0]!.value.maxInvestedCapital = '999';
    },
    (result) => {
      result.exposures[0]!.value.holdingMilliseconds = 1;
    },
    (result) => {
      result.exposures.pop();
    },
    (result) => {
      result.benchmarks.push(result.benchmarks[0]!);
    },
    (result) => {
      result.benchmarks[0]!.executionHash = '0'.repeat(64);
    },
    (result) => {
      result.benchmarks[0]!.artifact.report.strategy.parameters.entryAfterClosedCandles = 7;
    },
  ];
  for (const change of changes) {
    const result = structuredClone(original);
    change(result);
    for (const run of result.benchmarks) {
      const { reportHash, ...payload } = run.artifact;
      expect(reportHash).toMatch(/^[a-f0-9]{64}$/);
      run.artifact.reportHash = contentHash(payload);
    }
    expect(() => reviewStrategyBenchmarkStudy(rehash(result), manifest)).toThrow('STRATEGY_BENCHMARK_RESULT_INVALID');
  }
});
it('공개 snapshot 계약은 다른 비용 대조·중복·0체결 성공·음수/잘못된 노출을 거부한다', () => {
  const { exported, manifest } = fixture();
  const original = createStrategyResearchSnapshot(runStrategyBenchmarkStudy(manifest, [exported]), manifest);
  const wrongDifference = structuredClone(original);
  wrongDifference.rows[0]!.netPnlDifference = '999999';
  expect(() => parseStrategyResearchSnapshot(wrongDifference)).toThrow('INVALID_RESEARCH_ARITHMETIC');
  const changes: Array<(snapshot: typeof original) => void> = [
    (snapshot) => {
      snapshot.rows[0]!.execution.buyFeeBps = '20';
    },
    (snapshot) => {
      const row = snapshot.rows[0]!;
      row.metrics.fillCount = 0;
      row.tradePathObserved = false;
      row.comparisonStatus = 'strategy-no-fills';
      row.netPnlDifference = null;
    },
    (snapshot) => {
      snapshot.rows[0]!.exposure.holdingPct = '100.0000000001';
    },
    (snapshot) => {
      snapshot.rows[0]!.exposure.holdingMilliseconds = -1;
    },
    (snapshot) => {
      snapshot.rows[0]!.exposure.windowMilliseconds = 1;
    },
    (snapshot) => {
      snapshot.rows[0]!.exposure.averageInvestedCapital = '9'.repeat(40);
    },
    (snapshot) => {
      snapshot.rows.push(snapshot.rows[0]!);
    },
    (snapshot) => {
      snapshot.rows[0]!.comparisonStatus = 'strategy-no-fills';
      snapshot.rows[0]!.netPnlDifference = '1';
    },
    (snapshot) => {
      Reflect.set(snapshot, 'accountId', randomUUID());
    },
  ];
  for (const change of changes) {
    const snapshot = structuredClone(original);
    change(snapshot);
    expect(strategyResearchSnapshotSchema.safeParse(snapshot).success).toBe(false);
  }
});
it('CLI는 DB/키 없이 실행하고 결과 검토/공개 snapshot을 분리하며 live와 덮어쓰기를 거부한다', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hth-benchmark-'));
  directories.push(directory);
  const { exported, manifest } = fixture();
  const path = join(directory, 'manifest.json'),
    output = join(directory, 'result.json');
  await writeFile(path, JSON.stringify(manifest));
  await writeFile(join(directory, 'input.json'), JSON.stringify(exported));
  const executable = resolve('apps/worker/dist/strategy-benchmark-study-run.js');
  const args = [executable, `--manifest=${path}`, `--output=${output}`];
  const env = { PATH: process.env.PATH, NODE_ENV: 'test', TRADING_MODE: 'paper' };
  const run = await promisify(execFile)(process.execPath, args, { env });
  expect(JSON.parse(run.stdout)).toMatchObject({
    action: 'run',
    strategyRuns: 3,
    benchmarkRuns: 1,
    executionEnabled: false,
  });
  const initial = await readFile(output, 'utf8');
  const snapshot = join(directory, 'snapshot.json');
  const published = await promisify(execFile)(
    process.execPath,
    [executable, args[1]!, `--input=${output}`, '--snapshot', `--output=${snapshot}`],
    { env },
  );
  expect(JSON.parse(published.stdout)).toMatchObject({ action: 'snapshot', engineReexecuted: false });
  expect(strategyResearchSnapshotSchema.safeParse(JSON.parse(await readFile(snapshot, 'utf8'))).success).toBe(true);
  await expect(promisify(execFile)(process.execPath, args, { env })).rejects.toMatchObject({
    stderr: expect.stringContaining('EXPERIMENT_RESULT_EXISTS'),
  });
  expect(await readFile(output, 'utf8')).toBe(initial);
  await expect(
    promisify(execFile)(process.execPath, args, { env: { ...env, TRADING_MODE: 'live' } }),
  ).rejects.toMatchObject({ stderr: expect.stringContaining('BACKTEST_PAPER_ONLY') });
}, 15_000);
