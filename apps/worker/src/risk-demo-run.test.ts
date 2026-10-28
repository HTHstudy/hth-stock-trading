import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const execute = promisify(execFile);
it('데모 CLI는 키·DB 없이 동작하고 live와 파일 덮어쓰기를 거부한다', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hth-risk-cli-'));
  const output = join(directory, 'report.json');
  const args = ['--import', 'tsx', fileURLToPath(new URL('./risk-demo-run.ts', import.meta.url)), '--output', output];
  const env = { PATH: process.env.PATH, TRADING_MODE: 'paper', DATABASE_URL: 'invalid' };
  try {
    const result = await execute(process.execPath, args, { env });
    expect(JSON.parse(result.stdout)).toMatchObject({
      scenarios: 12,
      eligible: 2,
      blocked: 10,
      executionEnabled: false,
      currentAfterStop: false,
    });
    expect((await stat(output)).mode & 0o777).toBe(0o600);
    expect(await readFile(output, 'utf8')).not.toContain('synthetic-account');
    await expect(execute(process.execPath, args, { env })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('RISK_DEMO_REPORT_EXISTS'),
    });
    await expect(execute(process.execPath, args, { env: { ...env, TRADING_MODE: 'live' } })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('RISK_DEMO_PAPER_ONLY'),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);
