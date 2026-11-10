import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { authorityLabErrorCode, authorityLabMode, authorityLabPort, authorityLabSafety } from './authority-lab.js';

const id = 'a'.repeat(64),
  nonce = 'b'.repeat(32);
const receipt = () => ({
  id,
  nonce,
  ports: [{ HostIp: '127.0.0.1', HostPort: '63341' }],
  mounts: [],
  tmpfs: { '/var/lib/postgresql/data': 'rw,nosuid,size=256m' },
});
it('자신이 만든 컨테이너의 nonce·ID·loopback 임시 포트·tmpfs만 허용한다', () => {
  expect(authorityLabPort(receipt(), id, nonce)).toBe(63341);
  expect(authorityLabMode([], undefined)).toBe('preview');
  expect(authorityLabMode(['--execute'], 'paper')).toBe('execute');
  expect(authorityLabSafety.operatingEvidence).toBe(false);
  expect(authorityLabSafety.canResume).toBe(false);
});
it.each([
  { id: 'c'.repeat(64) },
  { nonce: 'c'.repeat(32) },
  { ports: null },
  { ports: [] },
  { ports: [{ HostIp: '0.0.0.0', HostPort: '63341' }] },
  { ports: [{ HostIp: '::1', HostPort: '63341' }] },
  { ports: [{ HostIp: '127.0.0.1', HostPort: '65536' }] },
  { ports: [{ HostIp: '127.0.0.1', HostPort: '5432/private' }] },
  { ports: [receipt().ports[0], receipt().ports[0]] },
  { mounts: [{ Type: 'bind', Destination: '/var/lib/postgresql/data' }] },
  { mounts: [{ Type: 'volume', Destination: '/var/lib/postgresql/data' }] },
  { tmpfs: {} },
  { tmpfs: { '/var/lib/postgresql/data': 'rw' } },
  { tmpfs: { '/wrong-path': 'rw,nosuid,size=256m' } },
  { unexpected: 'PRIVATE_TARGET' },
])('일치하지 않는 관리 receipt를 거부한다 %j', (patch) => {
  expect(() => authorityLabPort({ ...receipt(), ...patch }, id, nonce)).toThrow();
});
it.each([
  ['--execute', '--execute'],
  ['--url=postgresql://PRIVATE_TARGET/business'],
  ['--input=PRIVATE_TARGET'],
  ['--apply'],
  ['--execute', '--resume'],
  ['PRIVATE_TARGET'],
])('DB/원본/운영 대상을 지정하는 CLI를 거부한다 %j', (...args: string[]) => {
  expect(() => authorityLabMode(args, 'paper')).toThrow();
});
it.each(['live', '', 'PAPER'])('paper 외의 모드를 거부한다 %j', (mode) => {
  expect(() => authorityLabMode([], mode)).toThrow();
});
it('빌드된 CLI의 미리보기·잘못된 인자는 Docker/환경파일을 읽지 않고 비밀값을 출력하지 않는다', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'authority-lab-cli-'));
  const script = fileURLToPath(new URL('../dist/authority-lab-run.js', import.meta.url));
  try {
    await writeFile(join(directory, '.env'), 'TRADING_MODE=live\nPRIVATE_SECRET=DO_NOT_PRINT\n');
    await writeFile(join(directory, 'docker'), '#!/bin/sh\necho called > docker-called\nexit 1\n', { mode: 0o700 });
    const run = (args: string[], mode = 'paper') => {
      try {
        return execFileSync(process.execPath, [script, ...args], {
          cwd: directory,
          env: { PATH: directory, TRADING_MODE: mode, TEST_DATABASE_URL: 'PRIVATE_DB_URL' },
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        const e = error as { stderr: string; stdout: string; status: number };
        expect(e.status).toBe(1);
        return e.stderr + e.stdout;
      }
    };
    const preview = JSON.parse(run([]));
    expect(preview).toEqual({ state: 'preview', ...authorityLabSafety });
    for (const result of [run(['--execute', '--url=PRIVATE_TARGET']), run([], 'live')]) {
      expect(JSON.parse(result)).toEqual({ code: 'AUTHORITY_LAB_FAILED', ...authorityLabSafety });
      expect(result).not.toMatch(/PRIVATE_TARGET|PRIVATE_DB_URL|DO_NOT_PRINT/);
    }
    await expect(readFile(join(directory, 'docker-called'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('실패 단계 코드만 노출하고 원본 SQL/접속 오류는 숨긴다', () => {
  expect(authorityLabErrorCode(new Error('AUTHORITY_LAB_TARGET_FAILED'))).toBe('AUTHORITY_LAB_TARGET_FAILED');
  expect(authorityLabErrorCode(new Error('AUTHORITY_LAB_CLEANUP_FAILED'))).toBe('AUTHORITY_LAB_CLEANUP_FAILED');
  expect(authorityLabErrorCode(new Error('PRIVATE_PASSWORD postgres://secret'))).toBe('AUTHORITY_LAB_FAILED');
  expect(authorityLabErrorCode({ message: 'AUTHORITY_LAB_TARGET_FAILED' })).toBe('AUTHORITY_LAB_FAILED');
});

it.each(['invalid-receipt', 'uncertain-create'])(
  '가짜 Docker의 %s는 실패하며 확인하지 못한 대상을 정리하지 않는다',
  async (scenario) => {
    const directory = await mkdtemp(join(tmpdir(), 'authority-lab-docker-'));
    const script = fileURLToPath(new URL('../dist/authority-lab-run.js', import.meta.url));
    try {
      await writeFile(
        join(directory, 'docker'),
        [
          '#!/bin/sh',
          '[ "$1" = "--host" ] && [ "$2" = "unix:///var/run/docker.sock" ] && [ "$3" = "--config" ] || exit 9',
          'echo "$5" >> calls',
          'case "$5" in',
          scenario === 'uncertain-create' ? 'create) exit 1 ;;' : `create) echo '${id}' ;;`,
          'start|exec|rm) exit 0 ;;',
          "inspect) echo '{}' ;;",
          '*) exit 9 ;;',
          'esac',
          '',
        ].join('\n'),
        { mode: 0o700 },
      );
      let output = '';
      try {
        execFileSync(process.execPath, [script, '--execute'], {
          cwd: directory,
          env: { PATH: directory, TRADING_MODE: 'paper', DOCKER_HOST: 'tcp://PRIVATE_REMOTE:2375' },
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 10000,
        });
        throw new Error('EXPECTED_LAB_FAILURE');
      } catch (error) {
        const e = error as { stderr: string; status: number };
        expect(e.status).toBe(1);
        output = e.stderr;
      }
      expect(JSON.parse(output)).toEqual({
        code: scenario === 'invalid-receipt' ? 'AUTHORITY_LAB_TARGET_FAILED' : 'AUTHORITY_LAB_CREATE_FAILED',
        ...authorityLabSafety,
      });
      const calls = (await readFile(join(directory, 'calls'), 'utf8')).trim().split('\n');
      expect(calls).toEqual(scenario === 'invalid-receipt' ? ['create', 'start', 'exec', 'inspect', 'rm'] : ['create']);
      expect(output).not.toContain('PRIVATE_REMOTE');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
