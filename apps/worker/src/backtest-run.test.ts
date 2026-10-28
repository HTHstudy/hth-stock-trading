import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { contentHash } from '@hth/database';
import { createBacktestDemo } from './backtest-demo.js';
import type { createBacktestArtifact } from './backtest-artifact.js';

const execute = promisify(execFile);
const entry = fileURLToPath(new URL('./backtest-run.ts', import.meta.url));
const config = fileURLToPath(new URL('../../../examples/backtest-config.json', import.meta.url));
const environment = {
  PATH: process.env.PATH,
  TRADING_MODE: 'paper',
  DATABASE_URL: 'invalid',
  TOSS_CLIENT_ID: 'unused',
  TOSS_CLIENT_SECRET: 'unused',
};

it('CLI는 DB·키 없이 실행하고 보고서 hash·권한을 보장하며 덮어쓰기와 live를 거부한다', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hth-backtest-cli-'));
  const output = join(directory, 'report.json');
  const args = ['--import', 'tsx', entry, '--demo', '--config', config, '--output', output];
  try {
    const result = await execute(process.execPath, args, { env: environment });
    expect(result.stdout).toContain('"source":"synthetic-demo"');
    const { reportHash, ...payload } = JSON.parse(await readFile(output, 'utf8')) as ReturnType<
      typeof createBacktestArtifact
    >;
    expect(contentHash(payload)).toBe(reportHash);
    expect((await stat(output)).mode & 0o777).toBe(0o600);
    await expect(execute(process.execPath, args, { env: environment })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('BACKTEST_REPORT_EXISTS'),
    });
    await expect(
      execute(process.execPath, args, { env: { ...environment, TRADING_MODE: 'live' } }),
    ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('BACKTEST_PAPER_ONLY') });
    expect(
      contentHash((JSON.parse(await readFile(output, 'utf8')) as ReturnType<typeof createBacktestArtifact>).report),
    ).toBe(contentHash(payload.report));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);

it('CLI 파일 입력은 export hash를 확인하고 변조 시 결과를 만들지 않는다', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hth-backtest-file-'));
  const path = join(directory, 'dataset.json');
  const dataset = createBacktestDemo();
  const exported = { id: randomUUID(), contentHash: contentHash(dataset), dataset };
  const args = ['--import', 'tsx', entry, '--input', path, '--config', config];
  try {
    await writeFile(path, JSON.stringify(exported), { mode: 0o600 });
    expect((await execute(process.execPath, args, { env: environment })).stdout).toContain('"source":"file"');
    await writeFile(path, JSON.stringify({ ...exported, contentHash: '0'.repeat(64) }));
    await expect(execute(process.execPath, args, { env: environment })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('DATASET_INTEGRITY_FAILED'),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);
