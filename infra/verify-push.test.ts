import { spawnSync, spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';

const script = fileURLToPath(new URL('./verify-push.mjs', import.meta.url));
const head = 'a'.repeat(40),
  zero = '0'.repeat(40);
const input = `refs/heads/main ${head} refs/heads/main ${zero}\n`;
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'verify-push-'));
  const log = join(directory, 'steps.log');
  await writeFile(
    join(directory, 'git'),
    '#!/bin/sh\ncase "$1" in\nrev-parse) printf "%s" "$VERIFY_TEST_HEAD";;\nstatus) printf "%s" "$VERIFY_TEST_DIRTY";;\nesac\n',
    { mode: 0o700 },
  );
  await writeFile(
    join(directory, 'corepack'),
    '#!/bin/sh\nprintf "corepack:%s\\n" "$*" >> "$VERIFY_TEST_LOG"\n[ "$TEST_DATABASE_URL" = "postgresql://hth_test:local_test_only@127.0.0.1:54329/hth_readonly_test" ] || exit 9\nif [ "$VERIFY_TEST_WAIT" = 1 ]; then exec sleep 30; fi\nexit "${VERIFY_TEST_EXIT:-0}"\n',
    { mode: 0o700 },
  );
  await writeFile(
    join(directory, 'docker'),
    '#!/bin/sh\nprintf "docker:%s\\n" "$*" >> "$VERIFY_TEST_LOG"\ncase "$1" in\nrun) exit "${VERIFY_TEST_START_EXIT:-0}";;\nport) printf "%s" "${VERIFY_TEST_PORT:-127.0.0.1:54329}";;\nrm) exit "${VERIFY_TEST_CLEANUP_EXIT:-0}";;\nesac\n',
    { mode: 0o700 },
  );
  const env = {
    ...process.env,
    PATH: directory + ':' + process.env.PATH,
    VERIFY_TEST_HEAD: head,
    VERIFY_TEST_LOG: log,
    VERIFY_TEST_DIRTY: '',
    VERIFY_TEST_EXIT: '0',
    TEST_DATABASE_URL: 'PRIVATE_INHERITED_URL_NEVER_USE',
  };
  const run = (stdin = input, patch: Record<string, string | undefined> = {}) =>
    spawnSync(process.execPath, [script], { input: stdin, encoding: 'utf8', env: { ...env, ...patch } });
  const trace = async () =>
    (await readFile(log, 'utf8'))
      .trim()
      .replace(/hth-push-test-[a-f0-9-]+/g, '<db>')
      .split('\n');
  const start = () => {
    const child = spawn(process.execPath, [script], {
      env: { ...env, VERIFY_TEST_WAIT: '1' },
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    child.stdin.end(input);
    return child;
  };
  return { run, trace, log, start, cleanup: () => rm(directory, { recursive: true, force: true }) };
}
it('환경변수 없이 자체 임시 DB로 전체 CI와 Compose를 검사하고 DB를 제거한다', async () => {
  const f = await fixture();
  try {
    const result = f.run(input, { TEST_DATABASE_URL: undefined });
    expect(result.status, result.stderr).toBe(0);
    const steps = await f.trace();
    expect(steps[0]).toContain('docker:run --rm --detach --name <db>');
    expect(steps[0]).toContain('--publish 127.0.0.1::5432');
    expect(steps.slice(1)).toEqual([
      'docker:port <db> 5432',
      'docker:exec <db> pg_isready -h 127.0.0.1 -U hth_test -d hth_readonly_test',
      'corepack:pnpm verify:ci',
      'docker:compose -f infra/docker-compose.yml config --quiet',
      'docker:compose -f infra/compose.local.yml config --quiet',
      'docker:rm --force <db>',
    ]);
  } finally {
    await f.cleanup();
  }
});
it('상속된 업무 DB 설정을 재사용하지 않고 자격증명을 출력하지 않는다', async () => {
  const f = await fixture();
  try {
    const r = f.run();
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).not.toContain('PRIVATE_INHERITED_URL');
  } finally {
    await f.cleanup();
  }
});
it('작업 파일·다른 HEAD·잘못된 ref는 DB 생성 전 차단한다', async () => {
  const f = await fixture();
  try {
    expect(f.run(input, { VERIFY_TEST_DIRTY: ' M file.ts' }).status).toBe(1);
    expect(f.run(`refs/heads/other ${'b'.repeat(40)} refs/heads/other ${zero}`).status).toBe(1);
    expect(f.run('invalid').status).toBe(1);
    await expect(readFile(f.log)).rejects.toThrow();
  } finally {
    await f.cleanup();
  }
});
it('전체 검증 실패 시 종료 코드를 유지하고 DB를 제거하며 Compose는 실행하지 않는다', async () => {
  const f = await fixture();
  try {
    expect(f.run(input, { VERIFY_TEST_EXIT: '7' }).status).toBe(7);
    const steps = await f.trace();
    expect(steps.at(-2)).toBe('corepack:pnpm verify:ci');
    expect(steps.at(-1)).toBe('docker:rm --force <db>');
    expect(steps.some((s) => s.includes('docker:compose'))).toBe(false);
  } finally {
    await f.cleanup();
  }
});
it('DB 생성·포트·정리 오류는 성공으로 숨기지 않는다', async () => {
  const f = await fixture();
  try {
    for (const [patch, code] of [
      [{ VERIFY_TEST_START_EXIT: '3' }, 'PUSH_TEST_DATABASE_START_FAILED'],
      [{ VERIFY_TEST_PORT: '0.0.0.0:54329' }, 'PUSH_TEST_DATABASE_PORT_INVALID'],
      [{ VERIFY_TEST_CLEANUP_EXIT: '3' }, 'PUSH_TEST_DATABASE_CLEANUP_FAILED'],
    ] as const) {
      const r = f.run(input, patch);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(code);
    }
    expect((await f.trace()).at(-1)).toBe('docker:rm --force <db>');
  } finally {
    await f.cleanup();
  }
});
it('SIGTERM으로 중단해도 이번 임시 DB를 정리하고 실패로 끝난다', async () => {
  const f = await fixture();
  const child = f.start();
  try {
    let started = false;
    for (let n = 0; n < 100; n++) {
      const lines = await f.trace().catch((): string[] => []);
      if (lines.includes('corepack:pnpm verify:ci')) {
        started = true;
        break;
      }
      await delay(25);
    }
    expect(started).toBe(true);
    const closed = new Promise<number | null>((resolve) => child.once('close', resolve));
    child.kill('SIGTERM');
    expect(await closed).not.toBe(0);
    expect((await f.trace()).at(-1)).toBe('docker:rm --force <db>');
  } finally {
    child.kill();
    await f.cleanup();
  }
});
it('업데이트 없는 푸시와 삭제만 있으면 DB를 만들지 않는다', async () => {
  const f = await fixture();
  try {
    expect(f.run('').status).toBe(0);
    expect(f.run(`(delete) ${zero} refs/heads/old ${head}`).status).toBe(0);
    await expect(readFile(f.log)).rejects.toThrow();
  } finally {
    await f.cleanup();
  }
});
