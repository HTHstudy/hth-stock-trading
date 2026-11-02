import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { contentHash } from '@hth/database';
import { buildHistoricalDataset } from '@hth/trading';
import { createBacktestDemo } from './backtest-demo.js';
import { parseExperimentManifest, runBacktestExperiment } from './backtest-experiment.js';
import { readExperimentJson, writeExperimentResult } from './backtest-experiment-files.js';

const config = {
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
};
function fixture() {
  const dataset = createBacktestDemo();
  const exported = { id: randomUUID(), contentHash: contentHash(dataset), dataset };
  const manifest = {
    formatVersion: 'backtest-experiment-v1',
    datasets: [{ id: 'march', path: 'input.json', contentHash: exported.contentHash, role: 'research' }],
    variants: [
      { id: 'base', config },
      { id: 'stress', config: { ...config, execution: { ...config.execution, buyFeeBps: '50', slippageBps: '10' } } },
    ],
  };
  return { exported, manifest };
}
const directories: string[] = [];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'hth-experiment-'));
  directories.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

it('동일 입력의 반복 실행 hash가 같고 비용·설정·전체 체결 리포트를 보존한다', () => {
  const { exported, manifest } = fixture();
  const result = runBacktestExperiment(manifest, [exported]);
  expect(result).toEqual(runBacktestExperiment(manifest, [exported]));
  const { resultHash, ...payload } = result;
  expect(contentHash(payload)).toBe(resultHash);
  expect(result.runs).toHaveLength(2);
  expect(result.runs[0]!.tradePathObserved).toBe(true);
  expect(result.runs[0]!.artifact.report.metrics.totalFees).not.toBe(result.runs[1]!.artifact.report.metrics.totalFees);
  for (const run of result.runs) {
    const { reportHash, ...artifact } = run.artifact;
    expect(contentHash(artifact)).toBe(reportHash);
  }
  expect(JSON.stringify(result)).not.toContain('input.json');
});

it('0거래를 체결 경로 검증으로 표시하지 않는다', () => {
  const { exported, manifest } = fixture();
  manifest.variants = [{ id: 'warmup', config: { ...config, strategy: { fastPeriod: 100, slowPeriod: 200 } } }];
  const result = runBacktestExperiment(manifest, [exported]);
  expect(result.runs[0]!.tradePathObserved).toBe(false);
  expect(result.runs[0]!.artifact.report.metrics.tradeCount).toBe(0);
});

it('변조 파일·manifest hash 불일치·입력 수 불일치를 거부한다', () => {
  const { exported, manifest } = fixture();
  expect(() => runBacktestExperiment(manifest, [{ ...exported, contentHash: '0'.repeat(64) }])).toThrow(
    'DATASET_INTEGRITY_FAILED',
  );
  expect(() =>
    runBacktestExperiment({ ...manifest, datasets: [{ ...manifest.datasets[0], contentHash: '0'.repeat(64) }] }, [
      exported,
    ]),
  ).toThrow('EXPERIMENT_INPUT_MISMATCH');
  expect(() => runBacktestExperiment(manifest, [])).toThrow('EXPERIMENT_INPUT_MISMATCH');
});

it('중복 이름·미지원 필드·과도한 실행 조합을 거부한다', () => {
  const { manifest } = fixture();
  for (const input of [
    { ...manifest, variants: [manifest.variants[0], manifest.variants[0]] },
    { ...manifest, resume: true },
    {
      ...manifest,
      datasets: Array.from({ length: 8 }, (_, i) => ({ ...manifest.datasets[0], id: `d-${i}` })),
      variants: Array.from({ length: 8 }, (_, i) => ({ ...manifest.variants[0], id: `v-${i}` })),
    },
  ])
    expect(() => parseExperimentManifest(input)).toThrow('INVALID_EXPERIMENT_MANIFEST');
});

it('동일 종목의 겹치는 요청 기간은 validation 역할이어도 거부한다', () => {
  const { exported, manifest } = fixture();
  manifest.datasets.push({ ...manifest.datasets[0]!, id: 'validation', role: 'validation' });
  expect(() => runBacktestExperiment(manifest, [exported, exported])).toThrow('EXPERIMENT_OVERLAPPING_PERIODS');
});

it('서로 다른 통화·시간축·조정 기준 입력을 섞지 않는다', () => {
  const { exported, manifest } = fixture();
  manifest.datasets.push({ ...manifest.datasets[0]!, id: 'second' });
  const serialized = JSON.stringify(exported.dataset);
  for (const changed of [
    JSON.parse(serialized.replaceAll('"KRW"', '"USD"')) as unknown,
    JSON.parse(serialized.replaceAll('"1d"', '"1m"')) as unknown,
    JSON.parse(serialized.replaceAll('"adjusted":false', '"adjusted":true')) as unknown,
  ]) {
    const hash = contentHash(changed);
    manifest.datasets[1]!.contentHash = hash;
    expect(() =>
      runBacktestExperiment(manifest, [exported, { ...exported, dataset: changed, contentHash: hash }]),
    ).toThrow('EXPERIMENT_INCOMPARABLE_INPUTS');
  }
});

it('분리된 연구/검증 기간은 독립 초기 자금으로 실행하고 각 역할을 보존한다', () => {
  const { exported, manifest } = fixture();
  const split = (from: string, to: string) =>
    buildHistoricalDataset({
      ...exported.dataset,
      request: { ...exported.dataset.request, from, to },
      calendars: exported.dataset.calendars.filter(
        (item) => item.day.tradingDate >= from && item.day.tradingDate <= to,
      ),
      observations: exported.dataset.observations.filter(
        (item) => item.candle.tradingDate >= from && item.candle.tradingDate <= to,
      ),
    });
  const parts = [split('2026-03-02', '2026-03-13'), split('2026-03-16', '2026-03-31')].map((dataset) => ({
    id: randomUUID(),
    contentHash: contentHash(dataset),
    dataset,
  }));
  manifest.datasets = parts.map((part, i) => ({
    id: `period-${i}`,
    path: `${i}.json`,
    contentHash: part.contentHash,
    role: i ? 'validation' : 'research',
  }));
  const result = runBacktestExperiment(manifest, parts);
  expect(result.runs).toHaveLength(4);
  expect(result.runs.map((run) => run.role)).toEqual(['research', 'research', 'validation', 'validation']);
  expect(result.runs.every((run) => run.artifact.report.metrics.initialCash === '1000000')).toBe(true);
});

it('private 원자적 게시·크기 제한·심볼릭 링크 거부·기존 결과 보존을 검증한다', async () => {
  const root = await directory();
  const target = join(root, 'new', 'result.json');
  await writeExperimentResult(target, { test: true });
  expect(await readExperimentJson(target, 100)).toEqual({ test: true });
  expect((await stat(target)).mode & 0o777).toBe(0o600);
  expect((await stat(join(root, 'new'))).mode & 0o777).toBe(0o700);
  await expect(writeExperimentResult(target, { test: false })).rejects.toMatchObject({ code: 'EEXIST' });
  expect(await readdir(join(root, 'new'))).toEqual(['result.json']);
  await expect(readExperimentJson(target, 2)).rejects.toThrow('EXPERIMENT_FILE_TOO_LARGE');
  await symlink(target, join(root, 'link.json'));
  await expect(readExperimentJson(join(root, 'link.json'), 100)).rejects.toThrow();
});

it('여러 파일을 읽을 때 누적 입력 예산을 공유한다', async () => {
  const root = await directory();
  const target = join(root, 'input.json');
  await writeFile(target, '{"test":true}');
  const budget = { remainingBytes: 20 };
  expect(await readExperimentJson(target, 100, budget)).toEqual({ test: true });
  await expect(readExperimentJson(target, 100, budget)).rejects.toThrow('EXPERIMENT_FILE_TOO_LARGE');
});

it('키·DB 환경 없이 CLI를 실행하고 같은 결과 파일의 덮어쓰기를 차단한다', async () => {
  const root = await directory();
  const { exported, manifest } = fixture();
  await writeFile(join(root, 'input.json'), JSON.stringify(exported));
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest));
  const cli = resolve('apps/worker/dist/backtest-experiment-run.js');
  const args = [cli, '--manifest=manifest.json', '--output=result.json'];
  const options = { cwd: root, env: { TRADING_MODE: 'paper', NODE_ENV: 'test' }, timeout: 20000 };
  const { stdout } = await promisify(execFile)(process.execPath, args, options);
  const result = JSON.parse(await readFile(join(root, 'result.json'), 'utf8')) as { resultHash: string };
  expect(JSON.parse(stdout)).toMatchObject({ saved: true, resultHash: result.resultHash, executionEnabled: false });
  await expect(promisify(execFile)(process.execPath, args, options)).rejects.toMatchObject({
    stderr: expect.stringContaining('EXPERIMENT_RESULT_EXISTS'),
  });
  expect(JSON.parse(await readFile(join(root, 'result.json'), 'utf8'))).toEqual(result);
}, 30_000);
