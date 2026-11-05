import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { contentHash } from '@hth/database';
import { defaultPaperMarketPlan } from './paper-market-plan.js';
import { createPaperValidationResources } from './paper-validation-resources.js';

const execute = promisify(execFile),
  script = resolve('infra/authorized-paper-validation.mjs'),
  roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
it('기본 미리보기와 제어 전이 점검은 파일·키·DB·Paper 실행 없이 동작한다', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paper-validation-runner-'));
  roots.push(root);
  const before = await readdir(root);
  const run = (args: string[]) => execute(process.execPath, [script, ...args], { cwd: root, env: {}, timeout: 10000 });
  const preview = JSON.parse((await run(['--market=US'])).stdout);
  expect(preview).toMatchObject({ state: 'preview', resumeRequested: false, maxTicks: 60 });
  expect(JSON.parse((await run(['--market=US', '--selfcheck-control'])).stdout)).toMatchObject({
    ownTransitionsAccepted: 3,
    externalControlChangesRejected: 3,
    dbAccessed: false,
  });
  await expect(
    run(['--market=US', '--run', '--resume-authorized', '--resources-hash=' + '0'.repeat(64)]),
  ).rejects.toMatchObject({ stderr: expect.not.stringContaining('PRIVATE') });
  expect(await readdir(root)).toEqual(before);
}, 20000);
it('고정 입력 검증은 DB·환경파일·대기·계좌 변경 없이 먼저 완료한다', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paper-validation-runner-inputs-'));
  roots.push(root);
  const plan = defaultPaperMarketPlan({ market: 'US', symbol: 'AAPL' }),
    source = join(root, 'source.json');
  await writeFile(source, JSON.stringify(plan));
  const pinned = await createPaperValidationResources(join(root, 'inputs'), 'US', source, contentHash(plan));
  const args = [
    script,
    '--market=US',
    `--build-root=${resolve('.')}`,
    '--verify-inputs',
    `--resources=${pinned.directory}`,
    `--resources-hash=${pinned.resourcesHash}`,
  ];
  const before = await readdir(root);
  const result = await execute(process.execPath, args, { cwd: root, env: {}, timeout: 10000 });
  expect(JSON.parse(result.stdout)).toMatchObject({
    state: 'inputs-verified',
    dbAccessed: false,
    executionEnabled: false,
  });
  expect(await readdir(root)).toEqual(before);
  await writeFile(join(pinned.directory, 'plan.json'), JSON.stringify({ ...plan, cash: { KRW: '1', USD: '999' } }));
  await expect(execute(process.execPath, args, { cwd: root, env: {}, timeout: 10000 })).rejects.toMatchObject({
    stderr: expect.stringContaining('PAPER_MARKET_PLAN_HASH_MISMATCH'),
  });
  expect(await readdir(root)).toEqual(before);
}, 20000);
it('유효한 입력이 있어도 만료된 실행 기한과 잘못된 옵션은 시작 전에 거부한다', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paper-validation-runner-deadline-'));
  roots.push(root);
  const plan = defaultPaperMarketPlan({ market: 'US', symbol: 'AAPL' }),
    source = join(root, 'source.json');
  await writeFile(source, JSON.stringify(plan));
  const pinned = await createPaperValidationResources(join(root, 'inputs'), 'US', source, contentHash(plan));
  const base = [script, '--market=US', `--build-root=${resolve('.')}`];
  const before = await readdir(root);
  await expect(
    execute(
      process.execPath,
      [
        ...base,
        '--run',
        '--resume-authorized',
        `--resources=${pinned.directory}`,
        `--resources-hash=${pinned.resourcesHash}`,
        '--start-at=2020-01-01T00:00:00Z',
        '--deadline=2020-01-01T00:20:00Z',
        '--prerequisite=us-2020-01-01',
      ],
      { cwd: root, env: {}, timeout: 10000 },
    ),
  ).rejects.toMatchObject({ stderr: expect.stringContaining('PAPER_PREFLIGHT_FAILED') });
  for (const args of [
    ['--market=US', '--market=KR'],
    ['--market=US', '--resume'],
    ['--market=US', '--live'],
  ])
    await expect(
      execute(process.execPath, [script, ...args], { cwd: root, env: {}, timeout: 10000 }),
    ).rejects.toThrow();
  expect(await readdir(root)).toEqual(before);
}, 20000);

it('소유자가 생성할 run-id는 실제 실행에서만 허용하고 경로와 조회 모드 혼합은 거부한다', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paper-run-id-'));
  roots.push(root);
  for (const flags of [
    ['--run-id=../../other'],
    ['--run-id=not-a-uuid', '--run', '--resume-authorized'],
    ['--run-id=12345678-1234-4234-8234-123456789012', '--run', '--resume-authorized', '--fingerprint'],
  ])
    await expect(
      execute(process.execPath, [script, '--market=US', ...flags], { cwd: root, env: {}, timeout: 10000 }),
    ).rejects.toMatchObject({ stderr: expect.stringContaining('PAPER_PREFLIGHT_FAILED') });
  expect(await readdir(root)).toEqual([]);
}, 20000);

it('개장 5분 뒤 예약은 키·DB·대기·실행 기록 생성 전에 warmup 부족으로 거부한다', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paper-warmup-early-'));
  roots.push(root);
  const plan = defaultPaperMarketPlan({ market: 'US', symbol: 'AAPL' }),
    source = join(root, 'source.json');
  await writeFile(source, JSON.stringify(plan));
  const pinned = await createPaperValidationResources(join(root, 'inputs'), 'US', source, contentHash(plan));
  const session = Math.ceil((Date.now() + 3600000) / 60000) * 60000;
  const before = await readdir(root);
  await expect(
    execute(
      process.execPath,
      [
        script,
        '--market=US',
        `--build-root=${resolve('.')}`,
        '--run',
        '--resume-authorized',
        '--prerequisite=us-2026-11-05',
        `--resources=${pinned.directory}`,
        `--resources-hash=${pinned.resourcesHash}`,
        `--session-start=${new Date(session).toISOString()}`,
        `--session-end=${new Date(session + 390 * 60000).toISOString()}`,
        `--start-at=${new Date(session + 5 * 60000).toISOString()}`,
        `--deadline=${new Date(session + 30 * 60000).toISOString()}`,
      ],
      { cwd: root, env: {}, timeout: 10000 },
    ),
  ).rejects.toMatchObject({ stderr: expect.stringContaining('PAPER_STRATEGY_WARMUP_INSUFFICIENT') });
  expect(await readdir(root)).toEqual(before);
}, 20000);
