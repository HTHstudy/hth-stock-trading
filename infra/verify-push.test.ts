import { spawnSync, spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';

const script = fileURLToPath(new URL('./verify-push.mjs', import.meta.url));
const head = 'a'.repeat(40),
  zero = '0'.repeat(40),
  previous = 'b'.repeat(40);
const input = `refs/heads/main ${head} refs/heads/main ${zero}\n`;
const existing = `refs/heads/main ${head} refs/heads/main ${previous}\n`;
const fast = ['corepack:pnpm typecheck', 'corepack:pnpm exec vitest run --exclude **/*.integration.test.ts'];
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'verify-push-'));
  const log = join(directory, 'steps.log');
  await writeFile(
    join(directory, 'git'),
    '#!/bin/sh\ncase "$1" in\nrev-parse) printf "%s" "$VERIFY_TEST_HEAD";;\nstatus) printf "%s" "$VERIFY_TEST_DIRTY";;\ndiff) printf "%s\\000" "${VERIFY_TEST_PATH:-docs/README.md}"; exit "${VERIFY_TEST_DIFF_EXIT:-0}";;\nesac\n',
    { mode: 0o700 },
  );
  await writeFile(
    join(directory, 'corepack'),
    '#!/bin/sh\nprintf "corepack:%s\\n" "$*" >> "$VERIFY_TEST_LOG"\nif [ "$*" = "pnpm exec vitest run .integration.test.ts" ]; then\n  [ "$TEST_DATABASE_URL" = "postgresql://hth_test:local_test_only@127.0.0.1:54329/hth_readonly_test" ] || exit 9\n  if [ "$VERIFY_TEST_WAIT" = 1 ]; then exec sleep 30; fi\n  exit "${VERIFY_TEST_EXIT:-0}"\nfi\n[ -z "$TEST_DATABASE_URL" ] || exit 9\nexit "${VERIFY_TEST_FAST_EXIT:-0}"\n',
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
it('일반 웹·문서 변경은 Docker 없이 타입과 단위 테스트만 실행한다', async () => {
  const f = await fixture();
  try {
    for (const path of ['docs/README.md', 'apps/web/src/pages/overview/page.tsx']) {
      const r = f.run(existing, { VERIFY_TEST_PATH: path });
      expect(r.status, r.stderr).toBe(0);
    }
    expect(await f.trace()).toEqual([...fast, ...fast]);
  } finally {
    await f.cleanup();
  }
});
it('원장·트레이딩·계약·Paper·의존성 변경은 DB 통합 테스트도 실행한다', async () => {
  const f = await fixture();
  try {
    for (const path of [
      'packages/database/src/paper-ledger.ts',
      'packages/trading/src/risk/evaluate.ts',
      'packages/contracts/src/risk.ts',
      'apps/worker/src/paper-worker.ts',
      'apps/api/src/paper-source.ts',
      'pnpm-lock.yaml',
    ])
      expect(f.run(existing, { VERIFY_TEST_PATH: path }).status).toBe(0);
    const steps = await f.trace();
    expect(steps.filter((s) => s === 'corepack:pnpm exec vitest run .integration.test.ts')).toHaveLength(6);
    expect(steps.some((s) => s.includes('verify:ci') || s.includes('compose') || s === 'corepack:pnpm build')).toBe(
      false,
    );
  } finally {
    await f.cleanup();
  }
});
it('새 브랜치·비교 기준 미확인은 보수적으로 DB 검사하고 새 DB를 정리한다', async () => {
  const f = await fixture();
  try {
    expect(f.run().status).toBe(0);
    const steps = await f.trace();
    expect(steps.slice(0, 2)).toEqual(fast);
    expect(steps[2]).toContain('docker:run --rm --detach --name <db>');
    expect(steps[2]).toContain('--publish 127.0.0.1::5432');
    expect(steps.slice(3)).toEqual([
      'docker:port <db> 5432',
      'docker:exec <db> pg_isready -h 127.0.0.1 -U hth_test -d hth_readonly_test',
      'corepack:pnpm exec vitest run .integration.test.ts',
      'docker:rm --force <db>',
    ]);
    expect(f.run(existing, { VERIFY_TEST_DIFF_EXIT: '1' }).status).toBe(0);
    expect((await f.trace()).filter((s) => s === 'docker:rm --force <db>')).toHaveLength(2);
  } finally {
    await f.cleanup();
  }
});
it('상속된 DB 설정은 빠른 검사에 전달하지 않고 통합 검사에서도 새 주소만 사용한다', async () => {
  const f = await fixture();
  try {
    const r = f.run();
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).not.toContain('PRIVATE_INHERITED_URL');
  } finally {
    await f.cleanup();
  }
});
it('작업 파일·다른 HEAD·잘못된 ref는 검사와 DB 생성 전 차단한다', async () => {
  const f = await fixture();
  try {
    expect(f.run(input, { VERIFY_TEST_DIRTY: ' M file.ts' }).status).toBe(1);
    expect(f.run(`refs/heads/other ${previous} refs/heads/other ${zero}`).status).toBe(1);
    expect(f.run('invalid').status).toBe(1);
    await expect(readFile(f.log)).rejects.toThrow();
  } finally {
    await f.cleanup();
  }
});
it('타입/단위 검사 실패는 DB를 만들지 않고 실패 코드를 유지한다', async () => {
  const f = await fixture();
  try {
    expect(f.run(input, { VERIFY_TEST_FAST_EXIT: '7' }).status).toBe(7);
    expect(await f.trace()).toEqual([fast[0]]);
  } finally {
    await f.cleanup();
  }
});
it('통합 검사 실패는 코드를 유지하고 DB를 제거한다', async () => {
  const f = await fixture();
  try {
    expect(f.run(input, { VERIFY_TEST_EXIT: '7' }).status).toBe(7);
    const steps = await f.trace();
    expect(steps.at(-2)).toBe('corepack:pnpm exec vitest run .integration.test.ts');
    expect(steps.at(-1)).toBe('docker:rm --force <db>');
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
it('SIGTERM으로 통합 검사를 중단해도 임시 DB를 정리한다', async () => {
  const f = await fixture();
  const child = f.start();
  try {
    let started = false;
    for (let n = 0; n < 100; n++) {
      const lines = await f.trace().catch((): string[] => []);
      if (lines.includes('corepack:pnpm exec vitest run .integration.test.ts')) {
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
it('업데이트 없는 푸시와 삭제만 있으면 검사를 실행하지 않는다', async () => {
  const f = await fixture();
  try {
    expect(f.run('').status).toBe(0);
    expect(f.run(`(delete) ${zero} refs/heads/old ${head}`).status).toBe(0);
    await expect(readFile(f.log)).rejects.toThrow();
  } finally {
    await f.cleanup();
  }
});
