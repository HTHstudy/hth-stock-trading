import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { contentHash } from '@hth/database';
import type { ObservationChildLauncher } from './readonly-process-check.js';
import { runReadonlyProcessCheck, parseReadonlyProcessCheck } from './readonly-process-check.js';
import { verifyObservationEvidence } from './observation-evidence.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'readonly-process-check-'));
  roots.push(root);
  return root;
}
const env = {
  PATH: process.env.PATH,
  LANG: process.env.LANG,
  TZ: process.env.TZ,
  TOSS_CLIENT_ID: 'MUST_NOT_INHERIT',
  TOSS_CLIENT_SECRET: 'MUST_NOT_INHERIT',
  NODE_OPTIONS: 'MUST_NOT_INHERIT',
};
it('미리보기는 키·DB·빌드·파일·프로세스 없이 실행되고 위험한 옵션은 거부한다', async () => {
  const launch = vi.fn();
  expect(
    await runReadonlyProcessCheck([], {}, '/not-accessed', new AbortController().signal, { launch }),
  ).toMatchObject({ state: 'preview', maxChildren: 2, executionEnabled: false, canResume: false });
  expect(launch).not.toHaveBeenCalled();
  for (const args of [
    ['--resume'],
    ['--output=/tmp'],
    ['--kind=live'],
    ['--kind=market'],
    ['--kind=market', '--symbol=KR:005930,US:AAPL'],
  ])
    expect(() => parseReadonlyProcessCheck(args, {})).toThrow();
  expect(() => parseReadonlyProcessCheck([], { TRADING_MODE: 'live' })).toThrow();
});
it('실제 자식 프로세스 SIGTERM 정리와 새 프로세스 1회 완료를 합성 데이터로 검증한다', async () => {
  const root = await directory(),
    launch = vi.fn<ObservationChildLauncher>((...args) => spawn(...args));
  const result = await runReadonlyProcessCheck(['--execute'], env, resolve('.'), new AbortController().signal, {
    outputRoot: root,
    launch,
  });
  expect(result).toMatchObject({
    state: 'verified',
    forced: false,
    first: { status: 'cancelled', samples: 1 },
    second: { status: 'completed', samples: 1 },
    paperLedgerCompared: false,
    tokenExpiryVerified: false,
  });
  expect(launch).toHaveBeenCalledTimes(2);
  for (const call of launch.mock.calls) {
    expect(call[1]).not.toEqual(expect.arrayContaining([expect.stringMatching(/^--env-file/)]));
    expect(call[2]?.env).not.toHaveProperty('TOSS_CLIENT_SECRET');
    expect(call[2]?.env).not.toHaveProperty('NODE_OPTIONS');
  }
  if (!('id' in result)) throw new Error('Expected execution result');
  const folder = join(root, result.id);
  const artifact = JSON.parse(await readFile(join(folder, 'result.json'), 'utf8'));
  const { hash, ...body } = artifact;
  expect(hash).toBe(contentHash(body));
  expect((await stat(join(folder, 'result.json'))).mode & 0o777).toBe(0o600);
  expect(JSON.stringify(result)).not.toMatch(/MUST_NOT_INHERIT|clientSecret|accountId|pid|\/private\/|postgres/);
  const firstParent = join(folder, 'first'),
    [id] = await readdir(firstParent),
    first = join(firstParent, id!);
  const manifest = JSON.parse(await readFile(join(first, 'manifest.json'), 'utf8'));
  const terminal = JSON.parse(await readFile(join(first, 'summary.json'), 'utf8'));
  const journal = await readFile(join(first, 'samples.jsonl'), 'utf8');
  expect(() => verifyObservationEvidence(manifest, { ...terminal, journalSha256: '0'.repeat(64) }, journal)).toThrow();
  expect(() =>
    verifyObservationEvidence(manifest, { ...terminal, summary: { ...terminal.summary, samples: 2 } }, journal),
  ).toThrow();
  expect(() => verifyObservationEvidence(manifest, terminal, journal.slice(0, -1))).toThrow();
}, 15000);
it('첫 자식이 증거 없이 끝나면 재시도나 두 번째 자식을 시작하지 않는다', async () => {
  const root = await directory(),
    launch = vi.fn<ObservationChildLauncher>(() =>
      spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore', env: {} }),
    );
  const result = await runReadonlyProcessCheck(['--execute'], {}, resolve('.'), new AbortController().signal, {
    outputRoot: root,
    launch,
  });
  expect(result).toMatchObject({ state: 'failed', code: 'PROCESS_CHECK_FIRST_EXITED_EARLY', second: null });
  expect(launch).toHaveBeenCalledTimes(1);
});
it('종료를 거부하는 소유 자식만 강제 종료하고 정상 정리나 재시작으로 표시하지 않는다', async () => {
  const root = await directory(),
    launch = vi.fn<ObservationChildLauncher>(() =>
      spawn(process.execPath, ['-e', `process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`], {
        stdio: 'ignore',
        env: {},
      }),
    );
  const result = await runReadonlyProcessCheck(['--execute'], {}, resolve('.'), new AbortController().signal, {
    outputRoot: root,
    launch,
    firstTimeoutMs: 1500,
    graceMs: 100,
    killMs: 2000,
  });
  expect(result).toMatchObject({ state: 'failed', code: 'PROCESS_CHECK_FIRST_TIMEOUT', forced: true, second: null });
  expect(launch).toHaveBeenCalledTimes(1);
}, 10000);
it('검증 취소 시 현재 소유 자식을 정리하고 다음 프로세스를 시작하지 않는다', async () => {
  const root = await directory(),
    controller = new AbortController();
  const launch = vi.fn<ObservationChildLauncher>((...args) => {
    const child = spawn(...args);
    child.once('spawn', () => controller.abort());
    return child;
  });
  const result = await runReadonlyProcessCheck(['--execute'], {}, resolve('.'), controller.signal, {
    outputRoot: root,
    launch,
  });
  expect(result).toMatchObject({ state: 'failed', code: 'PROCESS_CHECK_CANCELLED', second: null });
  expect(launch).toHaveBeenCalledTimes(1);
});
