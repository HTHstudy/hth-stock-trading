import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import type { PaperReviewSnapshot } from '@hth/contracts';
import { contentHash } from '@hth/database';
import { paperReviewCheckpoint, reviewPaperCheckpoints } from './paper-review.js';
import { createPaperValidationStatus, summarizePaperValidation } from './paper-validation-status.js';

const roots: string[] = [];
const now = Date.parse('2026-11-03T01:30:00Z');
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'paper-validation-status-'));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
function fixture() {
  const before: PaperReviewSnapshot = {
    formatVersion: 'paper-review-snapshot-v1',
    source: 'toss-readonly',
    scope: contentHash('PRIVATE_ACCOUNT_SCOPE'),
    asOf: '2026-11-03T01:00:00Z',
    version: 10,
    epoch: 4,
    stopped: true,
    leasePresent: false,
    limitsHash: contentHash('limits'),
    strategyHash: contentHash('strategies'),
    cash: { KRW: '1000000', USD: '0' },
    dailyPnl: { KRW: { tradingDate: '2026-11-03', netPnl: '0' }, USD: { tradingDate: '2026-11-03', netPnl: '0' } },
    positions: [],
    basis: [],
    intents: [],
    fills: [],
    reservations: [],
    events: [],
  };
  const after = {
    ...before,
    version: 20,
    epoch: 7,
    asOf: '2026-11-03T01:15:00Z',
    events: ['LEASE_ACQUIRED', 'ACCOUNT_OBSERVED', 'STRATEGY_DIAGNOSED', 'LEASE_RELEASED'].map((kind, index) => ({
      key: contentHash(kind),
      kind: kind as 'LEASE_ACQUIRED',
      createdAt: `2026-11-03T01:10:0${index}Z`,
    })),
  };
  const a = paperReviewCheckpoint(before),
    b = paperReviewCheckpoint(after);
  const report = reviewPaperCheckpoints(a, b, '2026-11-03T01:15:01Z');
  return {
    id: randomUUID(),
    request: {
      formatVersion: 'authorized-paper-validation-v1',
      market: 'KR',
      prerequisite: 'kr-2026-11-03',
      startsAt: null,
      deadline: '2026-11-03T02:00:00Z',
      resumeRequested: true,
      maxTicks: 60,
      buildHash: contentHash('build'),
      expectedControlHash: contentHash('control'),
      automaticRetry: false,
      executionEnabled: false,
    },
    result: {
      formatVersion: 'authorized-paper-validation-result-v1',
      market: 'KR',
      state: 'completed-with-incomplete-review',
      resumeRequested: true,
      maxTicks: 60,
      completedTicks: 60,
      runningTicks: 60,
      verdict: report.verdict,
      stoppedAndCleaned: true,
      intents: 0,
      fills: 0,
      finishedAt: '2026-11-03T01:15:02Z',
      executionEnabled: false,
      automaticRetry: false,
    },
    before: a,
    after: b,
    review: { formatVersion: 'paper-review-artifact-v1', report, hash: contentHash(report) },
  };
}
async function save(root: string, f: ReturnType<typeof fixture>) {
  const folder = join(root, f.id);
  await mkdir(folder);
  for (const name of ['request', 'result', 'before', 'after', 'review'] as const)
    await writeFile(join(folder, `${name}.json`), JSON.stringify(f[name]));
  return folder;
}

it('연결된 대사 증거를 표시하고 체결 없는 미완료를 성공으로 바꾸지 않는다', () => {
  const f = fixture();
  const status = summarizePaperValidation(f.id, f, now);
  expect(status).toMatchObject({
    state: 'terminal-recorded',
    resultState: 'completed-with-incomplete-review',
    evidence: 'linked-review',
    verdict: 'incomplete',
    completedTicks: 60,
    stoppedAndCleaned: true,
    ledgerReviewRecomputed: false,
    processLivenessChecked: false,
    canResume: false,
  });
  const text = JSON.stringify(status);
  for (const value of [
    'scope',
    '"cash":',
    '1000000',
    'PRIVATE_ACCOUNT_SCOPE',
    'buildHash',
    'expectedControlHash',
    'leaseToken',
    'strategyHash',
  ])
    expect(text).not.toContain(value);
});

it('요청 기록만 있으면 기한이 지나도 실행/실패/프로세스 생존을 추정하지 않는다', () => {
  const f = fixture();
  const pending = { ...f, result: null, before: null, after: null, review: null };
  expect(summarizePaperValidation(f.id, pending, now + 86400000)).toMatchObject({
    state: 'awaiting-result',
    evidence: 'request-only',
    deadlineElapsed: true,
    completedTicks: null,
    verdict: null,
    processLivenessChecked: false,
  });
});

it('변조 hash·다른 checkpoint 연결·조작된 종료 수치·시장 불일치를 거부한다', () => {
  const f = fixture();
  for (const changed of [
    { ...f, review: { ...f.review, hash: '0'.repeat(64) } },
    { ...f, before: { ...f.before, hash: '0'.repeat(64) } },
    { ...f, result: { ...f.result, fills: 1 } },
    { ...f, result: { ...f.result, market: 'US' } },
    { ...f, request: { ...f.request, prerequisite: 'kr-2026-99-99' } },
    { ...f, review: null },
    { ...f, result: { ...f.result, state: 'completed' } },
  ])
    expect(() => summarizePaperValidation(f.id, changed, now)).toThrow();
});

it('완료 시각이 미래거나 checkpoint 순서가 뒤집히면 시각을 검증됨으로 표시하지 않는다', () => {
  const f = fixture();
  expect(
    summarizePaperValidation(f.id, { ...f, result: { ...f.result, finishedAt: '2026-11-04T01:00:00Z' } }, now).clock,
  ).toBe('unverified');
  expect(summarizePaperValidation(f.id, f, now - 86400000).clock).toBe('unverified');
});

it('review와 종료 기록의 시간 역행 및 같은 밀리초 안의 마이크로초 역행을 감지한다', () => {
  const f = fixture();
  const earlierReview = structuredClone(f);
  earlierReview.review.report.asOf = '2026-11-03T01:14:59Z';
  earlierReview.review.hash = contentHash(earlierReview.review.report);
  expect(summarizePaperValidation(f.id, earlierReview, now).clock).toBe('unverified');
  const laterReview = structuredClone(f);
  laterReview.review.report.asOf = '2026-11-03T01:15:03Z';
  laterReview.review.hash = contentHash(laterReview.review.report);
  expect(summarizePaperValidation(f.id, laterReview, now).clock).toBe('unverified');
  const reversed = structuredClone(f);
  reversed.before.snapshot.asOf = '2026-11-03T01:15:00.000002Z';
  reversed.before.hash = contentHash(reversed.before.snapshot);
  reversed.after.snapshot.asOf = '2026-11-03T01:15:00.000001Z';
  reversed.after.hash = contentHash(reversed.after.snapshot);
  reversed.review.report.beforeHash = reversed.before.hash;
  reversed.review.report.afterHash = reversed.after.hash;
  reversed.review.hash = contentHash(reversed.review.report);
  expect(summarizePaperValidation(f.id, reversed, now).clock).toBe('unverified');
});

it('고정된 대사 검사 이름만 내보내고 원본 체크 키를 노출하지 않는다', () => {
  const f = fixture();
  f.review.report.checks.privateKey = 'passed';
  f.review.hash = contentHash(f.review.report);
  expect(JSON.stringify(summarizePaperValidation(f.id, f, now))).not.toContain('privateKey');
});

it('파일 누락·변조·심볼릭 링크를 구분하며 원본 파일을 변경하지 않는다', async () => {
  const root = await directory(),
    f = fixture();
  const folder = await save(root, f);
  const original = await readFile(join(folder, 'review.json'), 'utf8');
  expect(await createPaperValidationStatus(root, () => now).list()).toMatchObject({
    availability: 'available',
    rejectedCount: 0,
    runs: [{ verdict: 'incomplete' }],
  });
  expect(await readFile(join(folder, 'review.json'), 'utf8')).toBe(original);
  await rm(join(folder, 'review.json'));
  await symlink(join(folder, 'before.json'), join(folder, 'review.json'));
  expect(await createPaperValidationStatus(root).list()).toMatchObject({ runs: [], rejectedCount: 1 });
  expect((await createPaperValidationStatus(join(root, 'missing')).list()).availability).toBe('not-recorded');
  const link = root + '-link';
  await symlink(root, link);
  roots.push(link);
  expect((await createPaperValidationStatus(link).list()).availability).toBe('unavailable');
});

it('부분 JSON·상한 초과 파일·잘못된 UUID 경로를 읽기 실패로 안전하게 제한한다', async () => {
  const root = await directory(),
    f = fixture();
  const folder = await save(root, f);
  await mkdir(join(root, 'not-a-uuid'));
  await writeFile(join(folder, 'result.json'), '{');
  expect(await createPaperValidationStatus(root).list()).toMatchObject({ runs: [], rejectedCount: 1 });
  await writeFile(join(folder, 'result.json'), ' '.repeat(16385));
  expect(await createPaperValidationStatus(root).list()).toMatchObject({ runs: [], rejectedCount: 1 });
});

it('스캔·반환 상한을 표시하고 UUID 순서를 최신 기록으로 주장하지 않는다', async () => {
  const root = await directory(),
    f = fixture();
  for (let i = 0; i < 51; i++) {
    const folder = join(root, randomUUID());
    await mkdir(folder);
    await writeFile(join(folder, 'request.json'), JSON.stringify(f.request));
  }
  const result = await createPaperValidationStatus(root).list();
  expect(result.limited).toBe(true);
  expect(result.runs).toHaveLength(50);
  expect(result.runs.every((run) => run.state === 'awaiting-result')).toBe(true);
});

it('CLI는 키/DB 없이 고정 루트만 조회하고 경로 옵션을 거부한다', async () => {
  const root = await directory();
  await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  const source = fileURLToPath(new URL('./paper-validation-status-run.ts', import.meta.url));
  const copied = join(root, 'apps/worker/src/paper-validation-status-run.ts');
  await mkdir(dirname(copied), { recursive: true });
  await writeFile(copied, await readFile(source));
  await symlink(
    fileURLToPath(new URL('./paper-validation-status.ts', import.meta.url)),
    join(dirname(copied), 'paper-validation-status.ts'),
  );
  await symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), join(root, 'apps/worker/node_modules'));
  const env = { TRADING_MODE: 'paper', NODE_ENV: 'test' },
    args = ['--import', import.meta.resolve('tsx'), copied];
  const execute = promisify(execFile);
  const before = await readdir(root);
  const { stdout } = await execute(process.execPath, args, { cwd: root, env, timeout: 10000 });
  expect(JSON.parse(stdout)).toMatchObject({
    availability: 'not-recorded',
    runs: [],
    executionEnabled: false,
    canResume: false,
  });
  await expect(
    execute(process.execPath, [...args, '--path=/private'], { cwd: root, env, timeout: 10000 }),
  ).rejects.toMatchObject({ stderr: expect.stringContaining('CONFIGURATION_INVALID') });
  expect(await readdir(root)).toEqual(before);
}, 30000);

it('진단 자료의 누락과 변조를 구분하고 진단 오류로 실행 종료 기록을 숨기지 않는다', async () => {
  const root = await directory(),
    f = fixture();
  const folder = await save(root, f);
  expect((await createPaperValidationStatus(root, () => now).list()).runs[0]?.diagnostics).toBeNull();
  await writeFile(join(folder, 'diagnostics.json'), '{');
  const result = await createPaperValidationStatus(root, () => now).list();
  expect(result.rejectedCount).toBe(0);
  expect(result.runs[0]).toMatchObject({ completedTicks: 60, diagnostics: { availability: 'unavailable' } });
});
