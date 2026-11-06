import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { contentHash } from '@hth/database';
import { backtestArtifactSchema } from '@hth/contracts';
import { buildHistoricalDataset } from '@hth/trading';
import { createBacktestDemo } from './backtest-demo.js';
import { createBacktestArtifact } from './backtest-artifact.js';
import { parseStrategyStudyManifest, reviewStrategyStudy, runStrategyStudy } from './strategy-study.js';

const execution = {
  initialCash: '10000',
  quantity: '1',
  priceTick: '1',
  buyFeeBps: '10',
  sellFeeBps: '30',
  sellTaxBps: '0',
  slippageBps: '5',
};
function fixture() {
  const dataset = createBacktestDemo();
  const exported = { id: randomUUID(), contentHash: contentHash(dataset), dataset };
  const manifest = parseStrategyStudyManifest({
    formatVersion: 'strategy-study-v1',
    purpose: 'exploratory-comparison',
    datasets: [
      {
        id: 'march',
        path: 'input.json',
        contentHash: exported.contentHash,
        request: dataset.request,
        role: 'research',
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
        strategy: { id: 'channel-breakout', version: '1.0.0', parameters: { entryPeriod: 3, exitPeriod: 2 } },
        execution,
      },
      {
        id: 'reversion',
        strategy: { id: 'mean-reversion', version: '1.0.0', parameters: { period: 3, entryDeviationBps: '100' } },
        execution,
      },
    ],
  });
  return { manifest, exported };
}
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const rehash = (result: ReturnType<typeof runStrategyStudy>) => {
  const { resultHash, ...payload } = result;
  expect(resultHash).toMatch(/^[a-f0-9]{64}$/);
  return { ...payload, resultHash: contentHash(payload) };
};

it('세 전략의 전체 보고서·종료 보유·비용을 보존하고 반복 hash가 같다', () => {
  const { manifest, exported } = fixture();
  const result = runStrategyStudy(manifest, [exported]);
  expect(runStrategyStudy(manifest, [exported])).toEqual(result);
  expect(result.runs).toHaveLength(3);
  expect(result.runs.every((run) => run.tradePathObserved)).toBe(true);
  expect(result).toMatchObject({ executionEnabled: false, strategySelected: false, independentHoldoutVerified: false });
  const review = reviewStrategyStudy(result, manifest);
  expect(review).toMatchObject({ datasetFilesReverified: false, engineReexecuted: false });
  expect(
    review.rows.every((row) => row.metrics.endingQuantity !== undefined && row.metrics.totalFees !== undefined),
  ).toBe(true);
  expect(JSON.stringify(result)).not.toContain('input.json');
  // Research artifacts cannot silently enter the moving-average-only public report store.
  expect(backtestArtifactSchema.safeParse(result.runs[1]!.artifact).success).toBe(false);
  expect(
    backtestArtifactSchema.safeParse({ ...result.runs[1]!.artifact, formatVersion: 'backtest-artifact-v1' }).success,
  ).toBe(false);
  expect(
    backtestArtifactSchema.safeParse({ ...result.runs[0]!.artifact, formatVersion: 'backtest-artifact-v1' }).success,
  ).toBe(true);
});

it('이동평균 기준 보고서의 기존 산술·신호·엔진 결과를 변경하지 않는다', () => {
  const { manifest, exported } = fixture();
  const legacy = createBacktestArtifact({
    dataset: exported.dataset,
    datasetId: exported.id,
    source: 'file',
    config: { strategy: { fastPeriod: 3, slowPeriod: 5 }, execution },
  });
  expect(runStrategyStudy(manifest, [exported]).runs[0]!.artifact.report).toEqual(legacy.report);
});

it('미래 가격을 바꿔 재구축해도 앞선 판단과 체결은 바뀌지 않는다', () => {
  const { manifest, exported } = fixture();
  const dataset = structuredClone(exported.dataset);
  for (const [index, observation] of dataset.observations.entries()) {
    if (index < 12) continue;
    observation.candle.open = '900';
    observation.candle.close = '900';
    observation.candle.high = '900';
    observation.candle.low = '900';
  }
  const rebuilt = buildHistoricalDataset(dataset);
  const changed = { ...exported, dataset: rebuilt, contentHash: contentHash(rebuilt) };
  const updatedManifest = structuredClone(manifest);
  updatedManifest.datasets[0]!.contentHash = changed.contentHash;
  const before = runStrategyStudy(manifest, [exported]),
    after = runStrategyStudy(updatedManifest, [changed]);
  for (let index = 0; index < 3; index++) {
    expect(after.runs[index]!.artifact.report.signals.slice(0, 12)).toEqual(
      before.runs[index]!.artifact.report.signals.slice(0, 12),
    );
    const boundary = Date.parse(dataset.observations[12]!.candle.timestamp);
    expect(after.runs[index]!.artifact.report.fills.filter((fill) => Date.parse(fill.timestamp) < boundary)).toEqual(
      before.runs[index]!.artifact.report.fills.filter((fill) => Date.parse(fill.timestamp) < boundary),
    );
  }
});

it('모르는 전략·버전·파라미터와 중복/과도한 조합을 거부한다', () => {
  const { manifest } = fixture();
  for (const input of [
    { ...manifest, live: true },
    { ...manifest, variants: [manifest.variants[0], manifest.variants[0]] },
    ...[{ id: 'unknown' }, { version: '2.0.0' }, { parameters: { period: 3 } }].map((change) => ({
      ...manifest,
      variants: [{ ...manifest.variants[0], strategy: { ...manifest.variants[0]!.strategy, ...change } }],
    })),
    {
      ...manifest,
      datasets: Array.from({ length: 8 }, (_, i) => ({ ...manifest.datasets[0], id: `d-${i}` })),
      variants: Array.from({ length: 8 }, (_, i) => ({ ...manifest.variants[0], id: `v-${i}` })),
    },
  ])
    expect(() => parseStrategyStudyManifest(input)).toThrow('INVALID_STRATEGY_STUDY_MANIFEST');
});

it('입력 hash/요청 불일치와 중첩 기간을 거부한다', () => {
  const { manifest, exported } = fixture();
  expect(() => runStrategyStudy(manifest, [{ ...exported, contentHash: '0'.repeat(64) }])).toThrow(
    'DATASET_INTEGRITY_FAILED',
  );
  expect(() => runStrategyStudy(manifest, [])).toThrow('EXPERIMENT_INPUT_MISMATCH');
  const wrongRequest = structuredClone(manifest);
  wrongRequest.datasets[0]!.request.to = '2026-03-30';
  expect(() => runStrategyStudy(wrongRequest, [exported])).toThrow('EXPERIMENT_INPUT_MISMATCH');
  expect(() =>
    runStrategyStudy({ ...manifest, datasets: [...manifest.datasets, { ...manifest.datasets[0], id: 'overlap' }] }, [
      exported,
      exported,
    ]),
  ).toThrow('EXPERIMENT_OVERLAPPING_PERIODS');
});

it('0체결은 경로 미검증이며 warmup·말기 미체결을 숨기지 않는다', () => {
  const { manifest, exported } = fixture();
  manifest.variants = [
    {
      id: 'warmup',
      strategy: { id: 'channel-breakout', version: '1.0.0', parameters: { entryPeriod: 50, exitPeriod: 10 } },
      execution,
    },
  ];
  const result = runStrategyStudy(manifest, [exported]);
  const row = reviewStrategyStudy(result, manifest).rows[0]!;
  expect(row.tradePathObserved).toBe(false);
  expect(row.warmupSignals).toBe(exported.dataset.candles.length);
  expect(row.metrics.fillCount).toBe(0);
});

it('외부 hash를 재계산해도 전략/비용 연결·조합 누락·중복·출처 변조를 차단한다', () => {
  const { manifest, exported } = fixture();
  const original = runStrategyStudy(manifest, [exported]);
  const changes: Array<(result: typeof original) => void> = [
    (result) => {
      result.runs[1]!.artifact.report.strategy = result.runs[0]!.artifact.report.strategy;
    },
    (result) => {
      result.runs[1]!.artifact.report.config.buyFeeBps = '20';
    },
    (result) => {
      result.runs.pop();
    },
    (result) => {
      result.runs[1] = result.runs[0]!;
    },
    (result) => {
      result.inputs[0]!.request.to = '2026-03-30';
    },
    (result) => {
      Reflect.set(result.runs[0]!.artifact.dataset, 'source', 'database');
    },
    (result) => {
      result.runs[0]!.tradePathObserved = false;
    },
  ];
  for (const change of changes) {
    const result = structuredClone(original);
    change(result);
    for (const run of result.runs) {
      const { reportHash, ...payload } = run.artifact;
      expect(reportHash).toMatch(/^[a-f0-9]{64}$/);
      run.artifact.reportHash = contentHash(payload);
    }
    expect(() => reviewStrategyStudy(rehash(result), manifest)).toThrow('STRATEGY_STUDY_RESULT_INVALID');
  }
});

it('CLI는 키/DB 없이 실행·검토하며 기존 결과 덮어쓰기와 live를 거부한다', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hth-strategy-study-'));
  directories.push(directory);
  const { manifest, exported } = fixture();
  const manifestPath = join(directory, 'manifest.json'),
    output = join(directory, 'result.json');
  await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(join(directory, 'input.json'), JSON.stringify(exported));
  const args = [resolve('apps/worker/dist/strategy-study-run.js'), `--manifest=${manifestPath}`, `--output=${output}`];
  const env = { PATH: process.env.PATH, NODE_ENV: 'test', TRADING_MODE: 'paper' };
  const run = await promisify(execFile)(process.execPath, args, { env });
  expect(JSON.parse(run.stdout)).toMatchObject({ runs: 3, executionEnabled: false });
  const initial = await readFile(output, 'utf8');
  await expect(promisify(execFile)(process.execPath, args, { env })).rejects.toMatchObject({
    stderr: expect.stringContaining('EXPERIMENT_RESULT_EXISTS'),
  });
  expect(await readFile(output, 'utf8')).toBe(initial);
  const reviewed = await promisify(execFile)(
    process.execPath,
    [args[0]!, args[1]!, `--input=${output}`, `--output=${join(directory, 'review.json')}`],
    { env },
  );
  expect(JSON.parse(reviewed.stdout)).toMatchObject({ action: 'review', engineReexecuted: false });
  await expect(
    promisify(execFile)(process.execPath, args, { env: { ...env, TRADING_MODE: 'live' } }),
  ).rejects.toMatchObject({
    stderr: expect.stringContaining('BACKTEST_PAPER_ONLY'),
  });
}, 15_000);
