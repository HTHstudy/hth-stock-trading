import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readdir, rm, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
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

it.each([false, true])(
  '전체 표본 검사 실패는 서버 환경·DB 이전에 기록한다 (supervised=%s)',
  async (supervised) => {
    const root = await mkdtemp(join(tmpdir(), 'paper-prerequisite-gate-'));
    roots.push(root);
    const buildRoot = join(root, 'code');
    const actual = resolve('.');
    const realModule = (name: string, path: string) =>
      `export { ${name} } from ${JSON.stringify(pathToFileURL(resolve(actual, path)).href)};`;
    const modules: Record<string, string> = {
      'packages/contracts/dist/index.js': realModule(
        'instantSchema, observationJobSchema',
        'packages/contracts/dist/index.js',
      ),
      'packages/database/dist/index.js': realModule('contentHash', 'packages/database/dist/index.js'),
      'apps/worker/dist/paper-validation-resources.js': realModule(
        'verifyPaperValidationResources, paperValidationFailureCode',
        'apps/worker/dist/paper-validation-resources.js',
      ),
      'apps/worker/dist/paper-market-plan.js': realModule(
        'readPaperMarketPlan, verifyPaperMarketPlan',
        'apps/worker/dist/paper-market-plan.js',
      ),
      'apps/worker/dist/paper-warmup.js': realModule(
        'planPaperWarmup, assessPaperWarmup',
        'apps/worker/dist/paper-warmup.js',
      ),
      'apps/worker/dist/paper-review-files.js': realModule(
        'writeReviewArtifact',
        'apps/worker/dist/paper-review-files.js',
      ),
      'apps/worker/dist/paper-validation-guards.js': `export {runGuardedPaperValidationPhase} from ${JSON.stringify(pathToFileURL(resolve(actual, 'apps/worker/dist/paper-validation-guards.js')).href)}; export function verifyPaperPrerequisite(_job,evidence){if(${supervised} && evidence.report.marker!=='supervised')throw new Error('WRONG_PREREQUISITE_ROUTE');throw new Error('PREREQUISITE_FAILED')}`,
      'apps/api/dist/observation-jobs.js': `export const createObservationJobs=()=>({list:async()=>({jobs:[{id:'kr-2026-11-09',state:'completed',reportId:'12345678-1234-4234-8234-123456789012'}]})});`,
      'apps/api/dist/observation-reports.js': `export const createObservationReports=()=>({getWithSampleRange:async()=>({report:{},sampleRange:{}})});`,
      'apps/api/dist/supervised-observation-prerequisite.js': `export const createSupervisedObservationPrerequisite=()=>({get:async()=>({job:{id:'kr-2026-11-09'},evidence:{report:{marker:'supervised'},sampleRange:{}},supervisionHash:'a'.repeat(64),sessionStartsAt:'2026-11-09T00:00:00Z',sessionEndsAt:'2026-11-09T06:30:00Z'})});`,
    };
    for (const path of [
      'packages/contracts/dist',
      'packages/broker/dist',
      'packages/trading/dist',
      'packages/database/dist',
      'apps/worker/dist',
      'apps/api/dist',
    ])
      await mkdir(join(buildRoot, path), { recursive: true });
    for (const [path, source] of Object.entries(modules)) await writeFile(join(buildRoot, path), source);
    await writeFile(join(buildRoot, 'package.json'), JSON.stringify({ type: 'module' }));
    await writeFile(join(buildRoot, 'pnpm-lock.yaml'), 'test-only-lock');
    const clock = join(root, 'clock.mjs');
    await writeFile(
      clock,
      `const original=Date;const now=original.parse('2026-11-09T01:30:00Z');globalThis.Date=class extends original{constructor(value){super(value===undefined?now:value)}static now(){return now}};`,
    );
    const plan = defaultPaperMarketPlan({ market: 'KR', symbol: '005930' }),
      source = join(root, 'source.json');
    await writeFile(source, JSON.stringify(plan));
    const pinned = await createPaperValidationResources(join(root, 'resources'), 'KR', source, contentHash(plan));
    const expectations = {
      KR: { version: 1, epoch: 1, entryHash: 'a'.repeat(64), limitsHash: 'b'.repeat(64), strategyHash: 'c'.repeat(64) },
    };
    const expectationsPath = join(root, 'expected.json');
    await writeFile(expectationsPath, JSON.stringify(expectations));
    const invoke = (args: string[]) =>
      execute(process.execPath, ['--import', clock, script, '--market=KR', `--build-root=${buildRoot}`, ...args], {
        cwd: root,
        env: {},
        timeout: 10000,
      });
    const fingerprint = (await invoke(['--fingerprint'])).stdout.trim();
    await expect(
      invoke([
        '--run',
        '--resume-authorized',
        `--build-hash=${fingerprint}`,
        `--resources=${pinned.directory}`,
        `--resources-hash=${pinned.resourcesHash}`,
        `--expectations=${expectationsPath}`,
        `--expectations-hash=${contentHash(expectations)}`,
        '--session-start=2026-11-09T00:00:00Z',
        '--session-end=2026-11-09T06:30:00Z',
        '--start-at=2026-11-09T01:30:00Z',
        '--deadline=2026-11-09T01:55:00Z',
        '--prerequisite=kr-2026-11-09',
        ...(supervised ? ['--prerequisite-supervision=89ab12cd-3456-4789-8abc-123456789012'] : []),
      ]),
    ).rejects.toMatchObject({ code: 1 });
    const runs = join(root, '.local-data/paper-validation-runs'),
      [id] = await readdir(runs);
    const result = JSON.parse(await readFile(join(runs, id!, 'result.json'), 'utf8'));
    expect(result).toMatchObject({
      phase: 'waiting',
      code: 'PREREQUISITE_FAILED',
      runStarted: false,
      completedTicks: 0,
      automaticRetry: false,
      executionEnabled: false,
    });
    expect(await readdir(join(runs, id!))).toEqual(
      expect.arrayContaining(['request.json', 'warmup-plan.json', 'result.json']),
    );
    expect(await readdir(join(runs, id!))).not.toContain('observation-evidence.json');
    // No server env file exists: passing the prerequisite would have failed in a different phase/code.
    await expect(readFile(join(root, '.env'))).rejects.toMatchObject({ code: 'ENOENT' });
  },
  20000,
);

it('감독 UUID가 잘못되면 조회/실행 파일과 DB 접근 전에 거부한다', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paper-supervised-flags-'));
  roots.push(root);
  for (const value of ['', '../private', 'not-a-uuid'])
    await expect(
      execute(process.execPath, [script, '--market=US', `--prerequisite-supervision=${value}`], {
        cwd: root,
        env: {},
        timeout: 10000,
      }),
    ).rejects.toMatchObject({ stderr: expect.stringContaining('PREREQUISITE_FAILED') });
  expect(await readdir(root)).toEqual([]);
}, 20000);
