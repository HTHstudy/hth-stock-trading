import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { parseDatasetExport } from './backtest-artifact.js';
import { createBacktestDemo } from './backtest-demo.js';
import { exportHistoricalDataset } from './historical-export.js';
import { parseBackfillOptions } from './data-backfill-options.js';

const directories: string[] = [];
const args = ['--market=US', '--symbol=aapl', '--from=2026-09-14', '--to=2026-10-30'];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'hth-historical-export-'));
  directories.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

it('기존 기본값을 보존하고 파일/DB 저장 충돌과 잘못된 경로를 I/O 전에 거부한다', () => {
  expect(parseBackfillOptions(args)).toMatchObject({ symbol: 'AAPL', save: false, interval: '1d' });
  expect(parseBackfillOptions([...args, '--output=new.json'])).toMatchObject({ output: 'new.json', save: false });
  expect(parseBackfillOptions([...args, '--save'])).toMatchObject({ save: true });
  for (const extra of [['--save', '--output=new.json'], ['--output='], ['--output=new.txt'], ['--unknown']])
    expect(() => parseBackfillOptions([...args, ...extra])).toThrow('INVALID_HISTORICAL_REQUEST');
});

it('완전한 동결 입력을 private 파일로 게시하고 기존 parser로 hash를 재검증한다', async () => {
  const root = await directory();
  const target = join(root, 'new', 'dataset.json');
  const dataset = createBacktestDemo();
  const receipt = await exportHistoricalDataset(target, dataset, new AbortController().signal);
  const artifact = parseDatasetExport(JSON.parse(await readFile(target, 'utf8')));
  expect(artifact).toMatchObject(receipt);
  expect(artifact.dataset).toEqual(dataset);
  expect((await stat(target)).mode & 0o777).toBe(0o600);
  expect((await stat(join(root, 'new'))).mode & 0o777).toBe(0o700);
  expect(await readdir(join(root, 'new'))).toEqual(['dataset.json']);
  expect(() => parseDatasetExport({ ...artifact, contentHash: '0'.repeat(64) })).toThrow('DATASET_INTEGRITY_FAILED');
});

it('기존 파일을 보존하고 실패한 임시 파일을 정리한다', async () => {
  const root = await directory();
  const target = join(root, 'dataset.json');
  await writeFile(target, 'existing');
  await expect(
    exportHistoricalDataset(target, createBacktestDemo(), new AbortController().signal),
  ).rejects.toMatchObject({ code: 'EEXIST' });
  expect(await readFile(target, 'utf8')).toBe('existing');
  expect(await readdir(root)).toEqual(['dataset.json']);
});

it('누락 커버리지·빈 봉·미종료 봉은 디렉터리를 만들기 전에 거부한다', async () => {
  const root = await directory();
  const dataset = createBacktestDemo();
  const inputs = [
    { ...dataset, coverage: { ...dataset.coverage, complete: false } },
    { ...dataset, candles: [] },
    { ...dataset, candles: dataset.candles.map((bar) => ({ ...bar, isClosed: false })) },
  ];
  for (const input of inputs)
    await expect(
      exportHistoricalDataset(join(root, 'new', 'dataset.json'), input, new AbortController().signal),
    ).rejects.toThrow();
  expect(await readdir(root)).toEqual([]);
});

it('이미 취소된 수집은 파일을 게시하지 않는다', async () => {
  const root = await directory();
  await expect(
    exportHistoricalDataset(join(root, 'dataset.json'), createBacktestDemo(), AbortSignal.abort()),
  ).rejects.toThrow();
  expect(await readdir(root)).toEqual([]);
});

it('부모 경로가 파일인 경우 기존 내용을 보존하고 실패한다', async () => {
  const root = await directory();
  const blocker = join(root, 'blocked');
  await writeFile(blocker, 'preserved');
  await expect(
    exportHistoricalDataset(join(blocker, 'dataset.json'), createBacktestDemo(), new AbortController().signal),
  ).rejects.toThrow();
  expect(await readFile(blocker, 'utf8')).toBe('preserved');
});
