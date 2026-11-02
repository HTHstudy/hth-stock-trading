import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';

const script = fileURLToPath(new URL('./verify-push.mjs', import.meta.url));
const head = 'a'.repeat(40),
  zero = '0'.repeat(40);
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'verify-push-'));
  const log = join(directory, 'steps.log');
  await writeFile(
    join(directory, 'git'),
    '#!/bin/sh\ncase "$1" in\nrev-parse) printf "%s" "$VERIFY_TEST_HEAD";;\nstatus) printf "%s" "$VERIFY_TEST_DIRTY";;\nesac\n',
    { mode: 0o700 },
  );
  for (const command of ['corepack', 'docker'])
    await writeFile(
      join(directory, command),
      `#!/bin/sh\nprintf "%s:%s\\n" "${command}" "$*" >> "$VERIFY_TEST_LOG"\nexit "\${VERIFY_TEST_EXIT:-0}"\n`,
      { mode: 0o700 },
    );
  const env = {
    ...process.env,
    PATH: directory + ':' + process.env.PATH,
    VERIFY_TEST_HEAD: head,
    VERIFY_TEST_LOG: log,
    VERIFY_TEST_DIRTY: '',
    VERIFY_TEST_EXIT: '0',
  };
  const run = (input = `refs/heads/main ${head} refs/heads/main ${zero}\n`, patch: Record<string, string> = {}) =>
    spawnSync(process.execPath, [script], { input, encoding: 'utf8', env: { ...env, ...patch } });
  return { run, log, cleanup: () => rm(directory, { recursive: true, force: true }) };
}
it('깨끗한 현재 HEAD만 전체 CI와 두 Compose 검사로 검증한다', async () => {
  const f = await fixture();
  try {
    expect(f.run().status).toBe(0);
    expect((await readFile(f.log, 'utf8')).trim().split('\n')).toEqual([
      'corepack:pnpm verify:ci',
      'docker:compose -f infra/docker-compose.yml config --quiet',
      'docker:compose -f infra/compose.local.yml config --quiet',
    ]);
  } finally {
    await f.cleanup();
  }
});
it('작업 중 파일이나 다른 커밋을 밀면 검증하지 않은 커밋의 푸시를 차단한다', async () => {
  const f = await fixture();
  try {
    expect(f.run(undefined, { VERIFY_TEST_DIRTY: ' M file.ts' }).status).toBe(1);
    expect(f.run(`refs/heads/other ${'b'.repeat(40)} refs/heads/other ${zero}`).status).toBe(1);
    expect(f.run('invalid').status).toBe(1);
    await expect(readFile(f.log)).rejects.toThrow();
  } finally {
    await f.cleanup();
  }
});
it('전체 검증 실패 코드를 유지하고 이후 검사를 진행하지 않는다', async () => {
  const f = await fixture();
  try {
    expect(f.run(undefined, { VERIFY_TEST_EXIT: '7' }).status).toBe(7);
    expect((await readFile(f.log, 'utf8')).trim()).toBe('corepack:pnpm verify:ci');
  } finally {
    await f.cleanup();
  }
});
it('업데이트가 없거나 원격 브랜치 삭제만 있으면 검증할 코드가 없다', async () => {
  const f = await fixture();
  try {
    expect(f.run('').status).toBe(0);
    expect(f.run(`(delete) ${zero} refs/heads/old ${head}`).status).toBe(0);
    await expect(readFile(f.log)).rejects.toThrow();
  } finally {
    await f.cleanup();
  }
});
