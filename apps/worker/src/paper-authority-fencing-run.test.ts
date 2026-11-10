import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const execute = promisify(execFile);
const entry = fileURLToPath(new URL('./paper-authority-fencing-run.ts', import.meta.url));
const tsx = import.meta.resolve('tsx');
const secret = 'authority-secret-must-never-appear';
const safety = {
  syntheticOnly: true,
  documentApproval: false,
  operatingApproval: false,
  actualAuthorityVerified: false,
  currentAuthorityVerified: false,
  externalEvidenceAuthenticated: false,
  policyApplied: false,
  dbAccessed: false,
  canIgnoreReservation: false,
  scheduled: false,
  resumeRequested: false,
  automaticRetry: false,
  originalFilesRead: false,
  executionEnabled: false,
  canResume: false,
};

// Module loading remains available; application file I/O and external transports fail closed.
const guard = `
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import child from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const deny = () => { throw new Error('${secret}'); };
for (const api of [fs, fsp]) {
  for (const name of ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync',
    'mkdir', 'mkdirSync', 'rename', 'renameSync', 'unlink', 'unlinkSync',
    'rm', 'rmSync', 'createWriteStream']) {
    if (name in api) api[name] = deny;
  }
  for (const name of ['readFile', 'readFileSync', 'open', 'openSync', 'createReadStream']) {
    if (!(name in api)) continue;
    const original = api[name];
    api[name] = function(path, ...args) {
      const value = String(path);
      if (value.includes(process.cwd()) || value.includes('.env') ||
        !(/\\.[cm]?[jt]s$/.test(value) || value.endsWith('/package.json') || value.endsWith('.node'))) deny();
      if (name.startsWith('open') && args[0] !== 'r') deny();
      return original.call(this, path, ...args);
    };
  }
}
for (const api of [net, tls, http, https, child]) {
  for (const name of ['connect', 'createConnection', 'createServer', 'request', 'get',
    'exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork']) {
    if (name in api) api[name] = deny;
  }
}
globalThis.fetch = deny;
syncBuiltinESMExports();
`;

async function run(args: string[], tradingMode: string | undefined = undefined) {
  const cwd = await mkdtemp(join(tmpdir(), 'hth-authority-cli-'));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    TSX_DISABLE_CACHE: '1',
    DATABASE_URL: `postgres://${secret}@127.0.0.1:1/${secret}`,
    TOSS_API_KEY: secret,
    TOSS_API_SECRET: secret,
    DOTENV_CONFIG_PATH: join(cwd, `.env-${secret}`),
  };
  if (tradingMode !== undefined) env.TRADING_MODE = tradingMode;
  try {
    expect(await readdir(cwd)).toEqual([]);
    const result = await execute(
      process.execPath,
      ['--import', tsx, '--import', `data:text/javascript,${encodeURIComponent(guard)}`, entry, ...args],
      { cwd, env, timeout: 10_000, maxBuffer: 64 * 1024 },
    ).then(
      ({ stdout, stderr }) => ({ stdout, stderr, code: 0 }),
      (error: unknown) => {
        if (!(error instanceof Error) || !('code' in error) || !('stdout' in error) || !('stderr' in error)) {
          throw error;
        }
        expect(typeof error.code).toBe('number');
        return { stdout: String(error.stdout), stderr: String(error.stderr), code: error.code };
      },
    );
    expect(await readdir(cwd)).toEqual([]);
    expect(result.stdout + result.stderr).not.toContain(secret);
    expect(result.stdout + result.stderr).not.toContain(cwd);
    expect(result.stdout + result.stderr).not.toContain('DATABASE_URL');
    expect(result.stdout + result.stderr).not.toContain('TOSS_API_KEY');
    return result;
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

it('인자가 없으면 환경 파일·외부 자료 없이 비적용 preview를 반환한다', async () => {
  for (const mode of [undefined, 'paper']) {
    const result = await run([], mode);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ state: 'preview', mode: 'preview', ...safety });
  }
}, 20_000);

it.each([
  { caseName: 'complete', reasons: [] },
  { caseName: 'missing-broker', reasons: ['EVIDENCE_MISSING'] },
  { caseName: 'existing-session', reasons: ['FENCE_UNVERIFIED'] },
  { caseName: 'changed-file', reasons: ['ORIGINAL_EVIDENCE_CHANGED'] },
  { caseName: 'cas-conflict', reasons: ['CONTROL_CONFLICT'] },
])(
  '내장 demo %s는 합성 검증만 수행하고 실제 권한을 승인하지 않는다',
  async ({ caseName, reasons }) => {
    const result = await run(['--demo', `--case=${caseName}`]);
    const state = caseName === 'complete' ? 'consistent-synthetic-scenario' : 'blocked';
    expect(result.code).toBe(state === 'consistent-synthetic-scenario' ? 0 : 2);
    expect(result.stderr).toBe('');
    const output = JSON.parse(result.stdout);
    expect(output).toMatchObject({ mode: 'demo', case: caseName, state, reasons, ...safety });
    expect(output.reasons).toEqual(reasons);
    for (const key of ['status', 'before', 'after', 'plan', 'evidence', 'approvals', 'authorityScopeHash', 'runId']) {
      expect(output).not.toHaveProperty(key);
    }
    expect(result.stdout).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  },
  15_000,
);

it('demo 기본 case는 complete이며 case와 demo의 순서는 무관하다', async () => {
  for (const args of [['--demo'], ['--case=complete', '--demo']]) {
    const result = await run(args);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    const output = JSON.parse(result.stdout);
    expect(output).toMatchObject({
      mode: 'demo',
      case: 'complete',
      state: 'consistent-synthetic-scenario',
      reasons: [],
      ...safety,
    });
    expect(output).not.toHaveProperty('status');
  }
}, 20_000);

it.each([
  ['--case=complete'],
  ['--demo', '--demo'],
  ['--demo', '--case=complete', '--case=complete'],
  ['--demo', '--case='],
  ['--demo', '--case=unknown'],
  ['--demo', '--case', 'complete'],
  ['--demo=true'],
  ['--unknown'],
  ['--'],
  ['complete'],
  ['--demo', secret],
  ['--apply'],
  ['--demo', '--apply'],
  ['--execute'],
  ['--demo', '--execute'],
  ['--input', `/private/${secret}`],
  [`--input=/private/${secret}`],
  ['--output', `/private/${secret}`],
  [`--output=/private/${secret}`],
])(
  '허용하지 않은 인자 %j는 고정 오류만 출력한다',
  async (...args) => {
    const result = await run(args);
    expect(result).toEqual({
      code: 1,
      stdout: '',
      stderr: `${JSON.stringify({ code: 'PAPER_AUTHORITY_SIMULATION_INVALID', ...safety })}\n`,
    });
  },
  15_000,
);

it.each(['live', '', 'PAPER', secret])(
  '잘못된 거래 모드 %j는 preview와 demo 모두 거부한다',
  async (mode) => {
    for (const args of [[], ['--demo']]) {
      const result = await run(args, mode);
      expect(result).toEqual({
        code: 1,
        stdout: '',
        stderr: `${JSON.stringify({ code: 'PAPER_AUTHORITY_SIMULATION_INVALID', ...safety })}\n`,
      });
    }
  },
  20_000,
);
