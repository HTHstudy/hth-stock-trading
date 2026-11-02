import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';

const script = fileURLToPath(new URL('./verify-ci.mjs', import.meta.url));
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'verify-ci-'));
  const log = join(directory, 'steps.log');
  await writeFile(
    join(directory, 'corepack'),
    '#!/bin/sh\nprintf "%s:%s\\n" "$CI" "$*" >> "$VERIFY_TEST_LOG"\nexit "${VERIFY_TEST_EXIT:-0}"\n',
    { mode: 0o700 },
  );
  const env: Record<string, string | undefined> = {
    ...process.env,
    PATH: directory + ':' + process.env.PATH,
    TEST_DATABASE_URL: 'postgresql://hth_test:fake@127.0.0.1:5432/hth_readonly_test',
    VERIFY_TEST_LOG: log,
  };
  delete env.VITEST_MAX_WORKERS;
  const run = (patch: Record<string, string | undefined> = {}, args: string[] = []) =>
    spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...env, ...patch } });
  return { run, log, cleanup: () => rm(directory, { recursive: true, force: true }) };
}
it('기본 CI 순서와 CI=true를 유지하며 인자나 단일 worker를 몰래 추가하지 않는다', async () => {
  const f = await fixture();
  try {
    expect(f.run().status).toBe(0);
    expect((await readFile(f.log, 'utf8')).trim().split('\n')).toEqual([
      'true:pnpm format:check',
      'true:pnpm lint',
      'true:pnpm typecheck',
      'true:pnpm test',
      'true:pnpm build',
    ]);
  } finally {
    await f.cleanup();
  }
});
it('테스트 DB 누락·일반 DB·외부 주소는 실행 전에 거부하고 자격증명을 출력하지 않는다', async () => {
  const f = await fixture();
  try {
    for (const url of [
      undefined,
      'postgresql://user:PRIVATE_PASSWORD@127.0.0.1/business',
      'postgresql://hth_test:PRIVATE_PASSWORD@remote/hth_readonly_test',
    ]) {
      const r = f.run({ TEST_DATABASE_URL: url });
      expect(r.status).toBe(1);
      expect(r.stdout + r.stderr).not.toContain('PRIVATE_PASSWORD');
      if (url === undefined) expect(r.stderr).toContain('VERIFY_CI_DEDICATED_DATABASE_REQUIRED');
    }
    await expect(readFile(f.log)).rejects.toThrow();
  } finally {
    await f.cleanup();
  }
});
it('단일 worker 환경변수와 임의 CLI 옵션을 거부한다', async () => {
  const f = await fixture();
  try {
    expect(f.run({ VITEST_MAX_WORKERS: '1' }).status).toBe(1);
    expect(f.run({}, ['--maxWorkers=1']).status).toBe(1);
    await expect(readFile(f.log)).rejects.toThrow();
  } finally {
    await f.cleanup();
  }
});
it('검사 하나가 실패하면 뒤 단계와 전체 통과를 기록하지 않는다', async () => {
  const f = await fixture();
  try {
    const r = f.run({ VERIFY_TEST_EXIT: '7' });
    expect(r.status).toBe(7);
    expect((await readFile(f.log, 'utf8')).trim()).toBe('true:pnpm format:check');
    expect(r.stdout).not.toContain('"state":"passed"');
  } finally {
    await f.cleanup();
  }
});
