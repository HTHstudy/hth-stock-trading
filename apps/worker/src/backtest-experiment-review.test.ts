import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { contentHash } from '@hth/database';
import { createBacktestDemo } from './backtest-demo.js';
import { runBacktestExperiment } from './backtest-experiment.js';
import { reviewBacktestExperiment } from './backtest-experiment-review.js';

function fixture() {
  const dataset = createBacktestDemo();
  const exported = { id: randomUUID(), contentHash: contentHash(dataset), dataset };
  const manifest = {
    formatVersion: 'backtest-experiment-v1',
    datasets: [{ id: 'research', role: 'research', path: 'unused.json', contentHash: exported.contentHash }],
    variants: [
      {
        id: 'base',
        config: {
          strategy: { fastPeriod: 3, slowPeriod: 5 },
          execution: {
            initialCash: '1000000',
            quantity: '10',
            priceTick: '1',
            buyFeeBps: '10',
            sellFeeBps: '10',
            sellTaxBps: '20',
            slippageBps: '5',
          },
        },
      },
    ],
  };
  return { manifest, result: runBacktestExperiment(manifest, [exported]) };
}
function rehash(result: ReturnType<typeof runBacktestExperiment>) {
  const payload: Partial<typeof result> = { ...result };
  delete payload.resultHash;
  return { ...payload, resultHash: contentHash(payload) };
}

it('저장된 결과의 관계와 hash를 검증하고 재실행·데이터 재검증과 구분한다', () => {
  const { manifest, result } = fixture();
  const review = reviewBacktestExperiment(result, manifest);
  expect(review).toMatchObject({
    formatVersion: 'backtest-experiment-review-v3',
    costComparisons: [],
    resultHash: result.resultHash,
    artifactIntegrityVerified: true,
    datasetFilesReverified: false,
    engineReexecuted: false,
    strategySelected: false,
    executionEnabled: false,
  });
  expect(review.rows[0]).toMatchObject({
    metrics: result.runs[0]!.artifact.report.metrics,
    config: result.runs[0]!.config,
    role: 'research',
  });
  expect(review.rows[0]!.unfilledAtEnd).toBe(
    result.runs[0]!.artifact.report.signals.filter((signal) => signal.status === 'UNFILLED_END').length,
  );
});

it('최상위 변조·내부 리포트 변조·잘못된 manifest를 거부한다', () => {
  const { manifest, result } = fixture();
  expect(() => reviewBacktestExperiment({ ...result, resultHash: '0'.repeat(64) }, manifest)).toThrow(
    'EXPERIMENT_RESULT_INVALID',
  );
  const changed = structuredClone(result);
  changed.runs[0]!.artifact.report.metrics.netPnl = '999999';
  expect(() => reviewBacktestExperiment(rehash(changed), manifest)).toThrow('EXPERIMENT_RESULT_INVALID');
  expect(() =>
    reviewBacktestExperiment(result, { ...manifest, datasets: [{ ...manifest.datasets[0], role: 'validation' }] }),
  ).toThrow('EXPERIMENT_RESULT_INVALID');
});

it('겉 hash를 바꿔도 누락/중복 조합과 설정·입력·체결 플래그 불일치를 거부한다', () => {
  const { manifest, result } = fixture();
  const mutate = (change: (value: typeof result) => void) => {
    const changed = structuredClone(result);
    change(changed);
    return rehash(changed);
  };
  const changedResults = [
    mutate((value) => {
      value.runs = [];
    }),
    mutate((value) => {
      value.runs[0]!.configHash = '0'.repeat(64);
    }),
    mutate((value) => {
      value.inputs[0]!.artifactId = randomUUID();
    }),
    mutate((value) => {
      value.runs[0]!.tradePathObserved = !value.runs[0]!.tradePathObserved;
    }),
  ];
  for (const changed of changedResults)
    expect(() => reviewBacktestExperiment(changed, manifest)).toThrow('EXPERIMENT_RESULT_INVALID');
  const two = { ...manifest, variants: [manifest.variants[0], { ...manifest.variants[0], id: 'second' }] };
  const duplicated = structuredClone(result);
  duplicated.manifestHash = contentHash(two);
  duplicated.runs.push(duplicated.runs[0]!);
  expect(() => reviewBacktestExperiment(rehash(duplicated), two)).toThrow('EXPERIMENT_RESULT_INVALID');
});

it('입력 dataset 파일과 키/DB가 없어도 검토 CLI를 실행하고 기존 출력은 보존한다', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'hth-experiment-review-'));
  try {
    const { manifest, result } = fixture();
    await writeFile(join(folder, 'manifest.json'), JSON.stringify(manifest));
    await writeFile(join(folder, 'result.json'), JSON.stringify(result));
    const args = [
      resolve('apps/worker/dist/backtest-experiment-review-run.js'),
      '--manifest=manifest.json',
      '--input=result.json',
      '--output=review.json',
    ];
    const options = { cwd: folder, env: { TRADING_MODE: 'paper' }, timeout: 10000 };
    const { stdout } = await promisify(execFile)(process.execPath, args, options);
    expect(JSON.parse(stdout)).toMatchObject({
      rows: 1,
      costComparisons: 0,
      artifactIntegrityVerified: true,
      engineReexecuted: false,
    });
    const before = await readFile(join(folder, 'review.json'), 'utf8');
    await expect(promisify(execFile)(process.execPath, args, options)).rejects.toMatchObject({
      stderr: expect.stringContaining('EXPERIMENT_RESULT_EXISTS'),
    });
    expect(await readFile(join(folder, 'review.json'), 'utf8')).toBe(before);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}, 30000);

it('검증한 조합만 비용 대조에 연결하고 변조된 결과에서 비교를 생성하지 않는다', () => {
  const dataset = createBacktestDemo();
  const exported = { id: randomUUID(), contentHash: contentHash(dataset), dataset };
  const { manifest } = fixture();
  manifest.datasets[0]!.contentHash = exported.contentHash;
  const stress = structuredClone(manifest.variants[0]!);
  stress.id = 'higher-cost';
  stress.config.execution.buyFeeBps = '20';
  stress.config.execution.sellFeeBps = '30';
  stress.config.execution.slippageBps = '10';
  manifest.variants.push(stress);
  const result = runBacktestExperiment(manifest, [exported]);
  const review = reviewBacktestExperiment(result, manifest);
  expect(review.costComparisons).toHaveLength(1);
  expect(review.costComparisons[0]).toMatchObject({
    dataset: 'research',
    lowerCostVariant: 'base',
    higherCostVariant: 'higher-cost',
    lowerReportHash: result.runs[0]!.artifact.reportHash,
    higherReportHash: result.runs[1]!.artifact.reportHash,
    changedCostFields: ['buyFeeBps', 'sellFeeBps', 'slippageBps'],
    sameFillTimingAndQuantity: true,
    sameSignalDecisions: true,
  });
  const changed = structuredClone(result);
  changed.runs[1]!.artifact.report.metrics.totalFees = '0';
  expect(() => reviewBacktestExperiment(rehash(changed), manifest)).toThrow('EXPERIMENT_RESULT_INVALID');
});
