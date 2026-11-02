import { mkdtemp, readFile, stat, writeFile, symlink, open, readdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { contentHash } from '@hth/database';
import { paperReviewArtifactSchema } from '@hth/contracts';
import { parsePaperReview, runPaperReview } from './paper-review-runtime.js';
import { readReviewEvidence, writeReviewArtifact } from './paper-review-files.js';

const dependencies = () => ({
  openDatabase: vi.fn(() => {
    throw new Error('DATABASE_FORBIDDEN');
  }),
  assertDatabase: vi.fn(),
});
it('미리보기는 키·DB·파일 없이 실행하고 live와 재개/마이그레이션 옵션은 거부한다', async () => {
  const d = dependencies();
  expect(await runPaperReview([], {}, d)).toMatchObject({
    state: 'preview',
    canResume: false,
    executionEnabled: false,
  });
  await expect(runPaperReview([], { TRADING_MODE: 'live' }, d)).rejects.toThrow();
  for (const flags of [
    ['--resume'],
    ['--prepare'],
    ['--capture', '--compare', '--output=x'],
    ['--kind=market'],
    ['--capture', '--account=existing', '--output=x'],
    ['--capture', '--account=paper-market-a', '--before=x', '--output=x'],
    ['--compare', '--account=paper-market-a', '--output=x'],
    ['--compare'],
  ])
    expect(() => parsePaperReview(flags)).toThrow();
  await expect(
    runPaperReview(
      ['--capture', '--account=paper-market-a', '--output=x'],
      { PAPER_MARKET_DATABASE_URL: 'postgresql://owner:PRIVATE@localhost/business' },
      d,
    ),
  ).rejects.toThrow();
  expect(d.openDatabase).not.toHaveBeenCalled();
});
it('오프라인 비교는 자료 누락/오류를 hash가 있는 미완료 리포트로 기록하고 DB에 접속하지 않는다', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paper-review-offline-'));
  const d = dependencies();
  try {
    const before = join(directory, 'broken.json'),
      output = join(directory, 'review.json');
    await writeFile(before, '{broken');
    const result = await runPaperReview(
      ['--compare', '--before=' + before, '--after=' + join(directory, 'missing.json'), '--output=' + output],
      {},
      d,
    );
    expect(result).toMatchObject({ state: 'report-written', verdict: 'incomplete', canResume: false });
    const artifact = paperReviewArtifactSchema.parse(JSON.parse(await readFile(output, 'utf8')));
    expect(artifact.hash).toBe(contentHash(artifact.report));
    expect(artifact.report.limitations).toContain('MISSING_CHECKPOINT');
    expect(artifact.report.limitations).toContain('INVALID_CHECKPOINT');
    expect(artifact.report.comparison).toBeNull();
    expect((await stat(output)).mode & 0o777).toBe(0o600);
    expect(d.openDatabase).not.toHaveBeenCalled();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
it('증거 파일은 크기/일반 파일을 검사하고 출력은 덮어쓰기 없이 원자적으로 보관한다', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paper-review-files-'));
  try {
    const path = join(directory, 'private', 'checkpoint.json');
    await writeReviewArtifact(path, { test: 1 });
    expect((await stat(join(directory, 'private'))).mode & 0o777).toBe(0o700);
    await expect(writeReviewArtifact(path, { test: 2 })).rejects.toThrow();
    expect(await readReviewEvidence(path)).toEqual({ test: 1 });
    const alias = join(directory, 'alias.json');
    await symlink(path, alias);
    expect(await readReviewEvidence(alias)).toEqual({ invalid: true });
    await expect(writeReviewArtifact(alias, { test: 3 })).rejects.toThrow();
    const oversized = join(directory, 'oversized.json');
    const file = await open(oversized, 'w');
    try {
      await file.truncate(32 * 1048576 + 1);
    } finally {
      await file.close();
    }
    expect(await readReviewEvidence(oversized)).toEqual({ invalid: true });
    expect(await readReviewEvidence(directory)).toEqual({ invalid: true });
    expect(await readReviewEvidence(undefined)).toBeNull();
    expect(await readdir(join(directory, 'private'))).toEqual(['checkpoint.json']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
it('실제 CLI는 키/DB 없이 미완료 종료 코드 2를 반환하고 민감한 입력을 출력하지 않는다', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paper-review-cli-'));
  try {
    const run = fileURLToPath(new URL('./paper-review-run.ts', import.meta.url));
    const cli = (args: string[]) =>
      spawnSync(process.execPath, ['--import', 'tsx', run, ...args], {
        encoding: 'utf8',
        env: { ...process.env, TRADING_MODE: 'paper', DATABASE_URL: 'PRIVATE_DATABASE_NOT_USED' },
      });
    expect(cli([]).status).toBe(0);
    const output = join(directory, 'report.json');
    const result = cli(['--compare', '--output=' + output]);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      verdict: 'incomplete',
      canResume: false,
      executionEnabled: false,
    });
    expect(result.stdout + result.stderr).not.toContain('PRIVATE_DATABASE_NOT_USED');
    const failed = cli(['--compare', '--output=' + output]);
    expect(failed.status).toBe(1);
    expect(JSON.parse(failed.stderr)).toMatchObject({ code: 'PAPER_REVIEW_FAILED' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
