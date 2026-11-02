import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';

const script = fileURLToPath(new URL('./test-related.mjs', import.meta.url));
async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'test-related-'))),
    log = join(directory, 'calls.jsonl');
  await mkdir(join(directory, 'infra'));
  await copyFile(script, join(directory, 'infra/test-related.mjs'));
  await writeFile(join(directory, 'infra/test-related.test.ts'), '');
  await mkdir(join(directory, 'packages/trading/dist/risk'), { recursive: true });
  await writeFile(join(directory, 'packages/trading/dist/risk/evaluate.js'), '');
  await writeFile(join(directory, 'packages/trading/dist/index.js'), '');
  await writeFile(
    join(directory, 'corepack'),
    '#!/usr/bin/env node\nconst fs=require("node:fs");fs.appendFileSync(process.env.RELATED_TEST_LOG,JSON.stringify({args:process.argv.slice(2),db:!!process.env.TEST_DATABASE_URL})+"\\n");process.exit(Number(process.env.RELATED_TEST_EXIT||0));\n',
    { mode: 0o700 },
  );
  const run = (args: string[], patch: Record<string, string> = {}) =>
    spawnSync(process.execPath, [join(directory, 'infra/test-related.mjs'), ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: directory + ':' + process.env.PATH,
        RELATED_TEST_LOG: log,
        TEST_DATABASE_URL: 'PRIVATE_NOT_FOR_TESTS',
        ...patch,
      },
    });
  const calls = async () =>
    (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { args: string[]; db: boolean });
  return { run, calls, log, directory, cleanup: () => rm(directory, { recursive: true, force: true }) };
}
it('변경된 infra 파일은 전체 빌드 없이 관련 단위 검사만 하고 DB 환경을 제거한다', async () => {
  const f = await fixture();
  try {
    expect(f.run(['infra/test-related.mjs']).status).toBe(0);
    const calls = await f.calls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args.slice(0, 8)).toEqual([
      'pnpm',
      'exec',
      'vitest',
      'related',
      '--run',
      '--exclude',
      '**/*.integration.test.ts',
      '--passWithNoTests',
    ]);
    expect(calls[0]!.args).toContain(join(f.directory, 'infra/test-related.test.ts'));
    expect(calls[0]!.db).toBe(false);
  } finally {
    await f.cleanup();
  }
});
it('패키지 변경은 준비 빌드 후 source/dist를 함께 추적한다', async () => {
  const f = await fixture();
  try {
    expect(f.run(['packages/trading/src/risk/evaluate.ts']).status).toBe(0);
    const calls = await f.calls();
    expect(calls[0]!.args).toEqual(['pnpm', 'build:packages']);
    expect(calls[1]!.args).toEqual(['pnpm', '--filter', '@hth/worker', 'build']);
    expect(calls[2]!.args).toContain(join(f.directory, 'packages/trading/src/risk/evaluate.ts'));
    expect(calls[2]!.args).toContain(join(f.directory, 'packages/trading/dist/risk/evaluate.js'));
    expect(calls.every((c) => !c.db)).toBe(true);
  } finally {
    await f.cleanup();
  }
});
it('공백이 있는 경로도 단일 인자로 전달하고 준비 실패는 커밋을 막는다', async () => {
  const f = await fixture();
  try {
    expect(f.run(['infra/source with space.mjs']).status).toBe(0);
    expect((await f.calls())[0]!.args.at(-1)).toBe(join(f.directory, 'infra/source with space.mjs'));
    expect(f.run(['apps/worker/src/paper-worker.ts'], { RELATED_TEST_EXIT: '7' }).status).toBe(1);
    expect((await f.calls()).at(-1)!.args).toEqual(['pnpm', 'build:packages']);
  } finally {
    await f.cleanup();
  }
});
it('입력이 없으면 생략하고 저장소 밖 경로는 명령 실행 전 거부한다', async () => {
  const f = await fixture();
  try {
    expect(f.run([]).status).toBe(0);
    expect(f.run(['../../outside.ts']).status).toBe(1);
    await expect(readFile(f.log)).rejects.toThrow();
  } finally {
    await f.cleanup();
  }
});
