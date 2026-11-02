import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type * as DatabaseModule from '@hth/database';
import { createBacktestDemo } from './backtest-demo.js';
import { parseDatasetExport } from './backtest-artifact.js';

const fake = vi.hoisted(() => ({
  collect: vi.fn(),
  verify: vi.fn(),
  freeze: vi.fn(),
  close: vi.fn(),
  database: vi.fn(),
}));
vi.mock('./readonly-config.js', () => ({
  parseReadonlyConfig: () => ({
    DATABASE_URL: 'not-used',
    TOSS_CLIENT_ID: 'fake-client',
    TOSS_CLIENT_SECRET: 'fake-secret',
  }),
}));
vi.mock('./historical-collect.js', () => ({ collectHistoricalDataset: fake.collect }));
vi.mock('@hth/broker/toss', () => ({ createTossReadonlyBroker: () => ({}) }));
vi.mock('@hth/database', async (original) => ({
  ...(await original<typeof DatabaseModule>()),
  createDatabase: fake.database,
}));

const originalArgv = process.argv;
const originalExitCode = process.exitCode;
const directories: string[] = [];
afterEach(async () => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function run(args: string[]) {
  vi.resetModules();
  fake.collect.mockReset().mockResolvedValue(createBacktestDemo());
  fake.verify.mockReset().mockResolvedValue(undefined);
  fake.freeze.mockReset().mockResolvedValue({ id: 'database-id', contentHash: 'a'.repeat(64) });
  fake.close.mockReset().mockResolvedValue(undefined);
  fake.database.mockReset().mockReturnValue({
    datasets: { verifySchema: fake.verify, freeze: fake.freeze },
    withBrokerLease: async (_key: number, collect: (signal: AbortSignal) => Promise<unknown>) =>
      collect(new AbortController().signal),
    close: fake.close,
  });
  const log = vi.spyOn(console, 'info').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  process.argv = [
    'node',
    'data-backfill',
    '--market=KR',
    '--symbol=DEMO',
    '--from=2026-03-02',
    '--to=2026-03-31',
    ...args,
  ];
  await import('./data-backfill.js');
  await vi.waitFor(() => expect(log.mock.calls.length + error.mock.calls.length).toBe(1));
  if (!error.mock.calls.length) await vi.waitFor(() => expect(fake.close).toHaveBeenCalledOnce());
  return { log, error };
}

it('파일 모드는 인증 lease 안에서 수집하지만 스키마 검사나 DB 동결을 호출하지 않는다', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hth-backfill-cli-'));
  directories.push(root);
  const target = join(root, 'dataset.json');
  const { log } = await run([`--output=${target}`]);
  expect(parseDatasetExport(JSON.parse(await readFile(target, 'utf8'))).dataset).toEqual(createBacktestDemo());
  expect(fake.verify).not.toHaveBeenCalled();
  expect(fake.freeze).not.toHaveBeenCalled();
  expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({
    storage: 'file',
    exported: true,
    saved: false,
    executionEnabled: false,
  });
});

it('기본 dry run은 저장하지 않고 기존 save는 스키마 검사와 동결을 유지한다', async () => {
  const first = await run([]);
  expect(fake.verify).not.toHaveBeenCalled();
  expect(fake.freeze).not.toHaveBeenCalled();
  expect(JSON.parse(first.log.mock.calls[0]![0] as string)).toMatchObject({
    storage: 'none',
    saved: false,
    exported: false,
  });
  first.log.mockRestore();
  first.error.mockRestore();
  await run(['--save']);
  expect(fake.verify).toHaveBeenCalledOnce();
  expect(fake.freeze).toHaveBeenCalledOnce();
});

it('충돌하는 저장 옵션은 DB와 broker 수집 이전에 차단한다', async () => {
  const { error } = await run(['--save', '--output=dataset.json']);
  expect(fake.database).not.toHaveBeenCalled();
  expect(fake.collect).not.toHaveBeenCalled();
  expect(JSON.parse(error.mock.calls[0]![0] as string)).toMatchObject({ code: 'INVALID_HISTORICAL_REQUEST' });
});
