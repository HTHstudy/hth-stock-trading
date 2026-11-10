import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import {
  assertRuntimeLabContainer,
  assertRuntimeLabVolume,
  runtimeSecretLabErrorCode,
  runtimeSecretLabMode,
  runtimeSecretLabSafety,
} from './runtime-secret-lab.js';
const id = 'a'.repeat(64),
  nonce = 'b'.repeat(32),
  volume = 'fake-owned-volume';
const receipt = () => ({
  id,
  nonce,
  network: 'none',
  privileged: false,
  readOnly: true,
  pidMode: '',
  capDrop: ['ALL'],
  mounts: [{ Type: 'volume', Name: volume, Destination: '/lab', RW: false }],
});
it('확인된 자체 볼륨/컨테이너와 마운트 없는 사례만 허용한다', () => {
  expect(
    assertRuntimeLabVolume({ name: volume, nonce, driver: 'local', options: null }, volume, nonce),
  ).toBeUndefined();
  expect(assertRuntimeLabContainer(receipt(), id, nonce, volume, false)).toBeUndefined();
  expect(assertRuntimeLabContainer({ ...receipt(), mounts: [] }, id, nonce, null, false)).toBeUndefined();
  expect(runtimeSecretLabMode([], undefined)).toBe('preview');
  expect(runtimeSecretLabMode(['--execute'], 'paper')).toBe('execute');
});
it.each([
  { id: 'c'.repeat(64) },
  { nonce: 'c'.repeat(32) },
  { network: 'bridge' },
  { privileged: true },
  { readOnly: false },
  { pidMode: 'host' },
  { capDrop: [] },
  { mounts: [] },
  { mounts: [...receipt().mounts, ...receipt().mounts] },
  { mounts: [{ ...receipt().mounts[0], Type: 'bind' }] },
  { mounts: [{ ...receipt().mounts[0], Name: 'existing-volume' }] },
  { mounts: [{ ...receipt().mounts[0], Destination: '/home' }] },
  { mounts: [{ ...receipt().mounts[0], RW: true }] },
  { unexpected: 'PRIVATE_INPUT' },
])('다른 대상·넓은 권한·추가 마운트를 거부한다 %j', (patch) => {
  expect(() => assertRuntimeLabContainer({ ...receipt(), ...patch }, id, nonce, volume, false)).toThrow();
});
it.each([
  { name: 'existing-volume' },
  { nonce: 'c'.repeat(32) },
  { driver: 'nfs' },
  { options: { device: '/private' } },
  { unexpected: true },
])('기존/외부 볼륨·driver 옵션을 거부한다 %j', (patch) => {
  expect(() =>
    assertRuntimeLabVolume({ name: volume, nonce, driver: 'local', options: null, ...patch }, volume, nonce),
  ).toThrow();
});
it.each([
  ['--execute', '--execute'],
  ['--path=PRIVATE_INPUT'],
  ['--volume=PRIVATE_INPUT'],
  ['--apply'],
  ['--execute', '--resume'],
])('외부 입력·실행 확장 옵션을 거부한다 %j', (...args: string[]) => {
  expect(() => runtimeSecretLabMode(args, 'paper')).toThrow();
});
it.each(['live', '', 'PAPER'])('paper 이외 모드를 거부한다 %j', (mode) => {
  expect(() => runtimeSecretLabMode([], mode)).toThrow();
});
it('오류 원문을 숨기고 고정 단계 코드만 제공한다', () => {
  expect(runtimeSecretLabErrorCode(new Error('RUNTIME_SECRET_LAB_TARGET_FAILED'))).toBe(
    'RUNTIME_SECRET_LAB_TARGET_FAILED',
  );
  expect(runtimeSecretLabErrorCode(new Error('RUNTIME_SECRET_LAB_CLEANUP_FAILED'))).toBe(
    'RUNTIME_SECRET_LAB_CLEANUP_FAILED',
  );
  expect(runtimeSecretLabErrorCode(new Error('PRIVATE_SECRET'))).toBe('RUNTIME_SECRET_LAB_FAILED');
});
const script = fileURLToPath(new URL('../dist/runtime-secret-lab-run.js', import.meta.url));
function invoke(directory: string, args: string[], mode = 'paper') {
  try {
    return {
      status: 0,
      output: execFileSync(process.execPath, [script, ...args], {
        cwd: directory,
        env: {
          PATH: directory,
          TRADING_MODE: mode,
          DOCKER_HOST: 'tcp://PRIVATE_REMOTE:2375',
          TOSS_CLIENT_SECRET: 'PRIVATE_SECRET',
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10000,
      }),
    };
  } catch (error) {
    const value = error as { status: number; stderr: string; stdout: string };
    return { status: value.status, output: value.stderr + value.stdout };
  }
}
it('미리보기/잘못된 인자는 환경파일을 읽거나 Docker를 실행하지 않는다', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'runtime-lab-preview-'));
  try {
    await writeFile(join(directory, '.env'), 'TRADING_MODE=live\nTOSS_CLIENT_SECRET=PRIVATE_ENV_SECRET\n');
    await writeFile(join(directory, 'docker'), '#!/bin/sh\necho called > calls\nexit 1\n', { mode: 0o700 });
    expect(JSON.parse(invoke(directory, []).output)).toEqual({ state: 'preview', ...runtimeSecretLabSafety });
    for (const result of [invoke(directory, ['--execute', '--path=PRIVATE_PATH']), invoke(directory, [], 'live')]) {
      expect(result.status).toBe(1);
      expect(JSON.parse(result.output)).toEqual({ code: 'RUNTIME_SECRET_LAB_FAILED', ...runtimeSecretLabSafety });
      expect(result.output).not.toMatch(/PRIVATE_/);
    }
    await expect(readFile(join(directory, 'calls'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
it.each(['uncertain-volume', 'invalid-volume', 'invalid-container', 'cleanup-failed'])(
  '가짜 Docker의 %s는 차단하고 소유 확인·정리 순서를 유지한다',
  async (scenario) => {
    const directory = await mkdtemp(join(tmpdir(), 'runtime-lab-failed-'));
    try {
      await writeFile(
        join(directory, 'docker'),
        [
          '#!/bin/sh',
          '[ "$1" = "--host" ] && [ "$2" = "unix:///var/run/docker.sock" ] && [ "$3" = "--config" ] || exit 9',
          'echo "$5:$6" >> calls',
          'case "$5:$6" in',
          scenario === 'uncertain-volume'
            ? 'volume:create) exit 1 ;;'
            : [
                'volume:create)',
                'for arg; do case "$arg" in hth.runtime-secret-lab=*) printf "%s" "${arg#*=}" > nonce ;; esac; last="$arg"; done',
                'printf "%s" "$last" > volume; echo "$last" ;;',
              ].join('\n'),
          scenario === 'invalid-volume'
            ? "volume:inspect) echo '{}' ;;"
            : `volume:inspect) read -r n < nonce; read -r v < volume; printf '{"name":"%s","nonce":"%s","driver":"local","options":null}\\n' "$v" "$n" ;;`,
          `create:*) echo '${id}' ;;`,
          'start:*) exit 0 ;;',
          "inspect:*) echo '{}' ;;",
          scenario === 'cleanup-failed' ? 'rm:*) exit 1 ;;' : 'rm:*|volume:rm) exit 0 ;;',
          '*) exit 9 ;;',
          'esac',
          '',
        ].join('\n'),
        { mode: 0o700 },
      );
      const result = invoke(directory, ['--execute']);
      expect(result.status).toBe(1);
      const expected =
        scenario === 'cleanup-failed'
          ? 'RUNTIME_SECRET_LAB_CLEANUP_FAILED'
          : scenario === 'invalid-container'
            ? 'RUNTIME_SECRET_LAB_TARGET_FAILED'
            : 'RUNTIME_SECRET_LAB_VOLUME_FAILED';
      expect(JSON.parse(result.output)).toEqual({ code: expected, ...runtimeSecretLabSafety });
      expect(result.output).not.toMatch(/PRIVATE_/);
      const calls = (await readFile(join(directory, 'calls'), 'utf8')).trim().split('\n');
      if (scenario === 'uncertain-volume') expect(calls).toEqual(['volume:create']);
      else if (scenario === 'invalid-volume') expect(calls).toEqual(['volume:create', 'volume:inspect']);
      else {
        expect(calls.map((c) => c.split(':')[0])).toEqual(
          scenario === 'cleanup-failed'
            ? ['volume', 'volume', 'create', 'start', 'inspect', 'rm']
            : ['volume', 'volume', 'create', 'start', 'inspect', 'rm', 'volume'],
        );
        if (scenario === 'invalid-container') expect(calls.at(-1)).toBe('volume:rm');
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
