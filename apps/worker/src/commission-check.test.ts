import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';

const execute = promisify(execFile);
const cli = resolve('apps/worker/dist/commission-check-run.js');
const directories: string[] = [];
const sentinel = {
  TOSS_CLIENT_ID: 'commission-test-client-sentinel',
  TOSS_CLIENT_SECRET: 'commission-test-secret-sentinel',
  // Deliberately invalid: any path reaching configuration/DB fails the expected code.
  DATABASE_URL: 'https://commission-test-database-sentinel.invalid',
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'commission-check-'));
  directories.push(path);
  return path;
}

async function rejected(args: string[], code: string, env: NodeJS.ProcessEnv = {}) {
  const cwd = await directory();
  await expect(execute(process.execPath, [cli, ...args], { cwd, env, timeout: 5000 })).rejects.toMatchObject({
    code: 1,
    stdout: '',
    stderr: JSON.stringify({ service: 'commission-check', code, executionEnabled: false }) + '\n',
  });
  expect(await readdir(cwd)).toEqual([]);
}

it.each([{}, sentinel, { ...sentinel, TRADING_MODE: 'paper' }])(
  'previews without connection config or filesystem output: %j',
  async (env) => {
    const cwd = await directory();
    const result = await execute(process.execPath, [cli], { cwd, env, timeout: 5000 });
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      service: 'commission-check',
      state: 'preview',
      executionEnabled: false,
    });
    expect(await readdir(cwd)).toEqual([]);
  },
);

it.each([[], ['--check', '--output=evidence.json']].map((args) => ({ args })))(
  'rejects live before I/O: %j',
  async ({ args }) => {
    await rejected(args, 'TRADING_MODE_INVALID', { ...sentinel, TRADING_MODE: 'live' });
  },
);

it.each(
  [
    ['--check'],
    ['--output=evidence.json'],
    ['--check', '--output='],
    ['--check', '--check', '--output=evidence.json'],
    ['--check', '--output=one.json', '--output=two.json'],
    ['--check=true', '--output=evidence.json'],
    ['--unknown'],
    ['--save'],
    ['evidence.json'],
    ['--'],
    ['--check', '--output=evidence.json', 'extra'],
  ].map((args) => ({ args })),
)('rejects malformed options before connection config: %j', async ({ args }) => {
  await rejected(args, 'INVALID_OPTIONS', sentinel);
});

it.each(['evidence.txt', 'evidence.json.tmp', 'evidence.json/'])(
  'validates output suffix before DB: %s',
  async (output) => {
    await rejected(['--check', `--output=${output}`], 'EXPERIMENT_OUTPUT_JSON_REQUIRED', sentinel);
  },
);

it.each([{}, { TOSS_CLIENT_ID: sentinel.TOSS_CLIENT_ID }, sentinel])(
  'requires explicit valid connection configuration on check: %j',
  async (env) => {
    await rejected(['--check', '--output=evidence.json'], 'READONLY_CONFIGURATION_INVALID', env);
  },
);

it('accepts a space-separated output argument before requiring connection configuration', async () => {
  await rejected(['--check', '--output', 'evidence.json'], 'READONLY_CONFIGURATION_INVALID', sentinel);
});
