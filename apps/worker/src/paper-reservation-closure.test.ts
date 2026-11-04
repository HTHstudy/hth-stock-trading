import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type * as FsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { contentHash } from '@hth/database';
import { planPaperReservationClosure, verifyPaperReservationClosure } from './paper-reservation-closure.js';
import { createPaperReservationClosures } from './paper-reservation-closure-store.js';
import { createPaperValidationStatus } from './paper-validation-status.js';

const mutation = vi.hoisted(() => ({ current: null as null | (() => Promise<void>) }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof FsPromises>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      if (String(args[0]).endsWith('/exit.json') && mutation.current) {
        const run = mutation.current;
        mutation.current = null;
        await run();
      }
      return fs.open(...args);
    },
  };
});
const roots: string[] = [];
afterEach(async () => {
  mutation.current = null;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const now = Date.parse('2026-11-04T10:00:00Z');
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'paper-closure-')));
  roots.push(root);
  const runId = randomUUID(),
    launchId = randomUUID(),
    nonce = randomUUID();
  const folder = join(root, '.local-data/paper-validation-runs', runId),
    witness = join(root, '.local-data/paper-validation-processes', launchId);
  await mkdir(folder, { recursive: true });
  await mkdir(witness, { recursive: true });
  const terminal = {
    formatVersion: 'authorized-paper-validation-result-v1',
    market: 'US',
    state: 'stopped-before-run-or-failed',
    resumeRequested: true,
    maxTicks: 60,
    completedTicks: 0,
    phase: 'waiting',
    runStarted: false,
    code: 'PAPER_BUILD_CHANGED',
    finishedAt: '2026-11-04T09:00:01Z',
    executionEnabled: false,
    automaticRetry: false,
  };
  const bytes = JSON.stringify(terminal);
  await writeFile(join(folder, 'result.json'), bytes);
  const snapshot = {
    runId,
    files: [
      {
        name: 'result.json',
        bytes: Buffer.byteLength(bytes),
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
    ],
    missing: ['request.json', 'before.json', 'after.json', 'review.json'],
  };
  const launch = {
    formatVersion: 'owned-paper-launch-v1',
    id: launchId,
    runId,
    nonce,
    runnerHash: contentHash('runner'),
    argumentsHash: contentHash('args'),
    startedAt: '2026-11-04T09:00:00Z',
    automaticRetry: false,
    executionEnabled: false,
    canResume: false,
  };
  const exitBody = {
    formatVersion: 'owned-paper-exit-v1',
    launchId,
    runId,
    nonce,
    launchHash: contentHash(launch),
    exitCode: 1,
    signal: null,
    forced: false,
    clockUnverified: false,
    observedExitAt: '2026-11-04T09:00:02Z',
    executionEnabled: false,
    canResume: false,
  };
  const exit = { ...exitBody, hash: contentHash(exitBody) };
  await writeFile(join(witness, 'launch.json'), JSON.stringify(launch));
  await writeFile(join(witness, 'exit.json'), JSON.stringify(exit));
  return {
    root,
    runId,
    launchId,
    folder,
    witness,
    input: { terminal, snapshot, launch, exit },
    store: createPaperReservationClosures(root, () => now),
  };
}
it('독립 소유 프로세스 종료 증거를 확인한 별도 처리만 허용하며 과거 조회를 바꾸지 않는다', async () => {
  const f = await fixture(),
    original = await readFile(join(f.folder, 'result.json'));
  const reader = createPaperValidationStatus(join(f.root, '.local-data/paper-validation-runs'), () => now);
  expect(await reader.checkReservations()).toMatchObject({ rejectedCount: 1, unresolvedCount: 1, retiredCount: 0 });
  const plan = await f.store.inspect(f.runId, f.launchId);
  expect(await f.store.apply(f.runId, f.launchId, plan.hash, 'RETIRE_ORPHANED_RESERVATION')).toMatchObject({
    reservationRetired: true,
    canResume: false,
  });
  expect(await reader.list()).toMatchObject({ rejectedCount: 1, runs: [] });
  expect(await reader.checkReservations()).toMatchObject({ rejectedCount: 1, unresolvedCount: 0, retiredCount: 1 });
  expect(await f.store.verify(f.runId)).toMatchObject({ historicalOutcomeVerified: false, executionEnabled: false });
  expect(await readdir(f.folder)).toEqual(['result.json']);
  expect(await readFile(join(f.folder, 'result.json'))).toEqual(original);
  const receipt = join(f.root, '.local-data/paper-reservation-closures', f.runId + '.json');
  expect((await stat(receipt)).mode & 0o777).toBe(0o600);
  await expect(f.store.apply(f.runId, f.launchId, plan.hash, 'RETIRE_ORPHANED_RESERVATION')).rejects.toThrow();
});
it('자기 보고 종료 파일·PID·수동 확인만으로는 처리 계획을 만들지 않는다', async () => {
  const f = await fixture();
  for (const patch of [
    { launch: null, exit: null },
    { exit: { pid: 123, terminated: true } },
    { launch: { ...f.input.launch, ownerConfirmed: true } },
  ])
    expect(() => planPaperReservationClosure({ ...f.input, ...patch }, now)).toThrow();
  await rm(join(f.witness, 'exit.json'));
  await expect(f.store.inspect(f.runId, f.launchId)).rejects.toThrow();
  expect(await readdir(f.folder)).toEqual(['result.json']);
});
it('종료/실행 ID·nonce·hash·시각·강제 종료·코드와 실제 실행 흔적을 엄격히 검증한다', async () => {
  const f = await fixture();
  for (const patch of [
    { runId: randomUUID() },
    { launchId: randomUUID() },
    { nonce: randomUUID() },
    { forced: true },
    { clockUnverified: true },
    { signal: 'SIGKILL' },
    { exitCode: null },
    { exitCode: 0 },
    { observedExitAt: '2026-11-04T08:00:00Z' },
    { observedExitAt: '2026-11-05T09:00:00Z' },
    { launchHash: contentHash('other') },
  ]) {
    const body = { ...f.input.exit };
    Reflect.deleteProperty(body, 'hash');
    const exit = { ...body, ...patch };
    expect(() =>
      planPaperReservationClosure({ ...f.input, exit: { ...exit, hash: contentHash(exit) } }, now),
    ).toThrow();
  }
  for (const patch of [
    { runStarted: true },
    { completedTicks: 1 },
    { phase: 'authorized-paper-run' },
    { code: 'CANCELLED' },
    { fills: 1 },
    { stoppedAndCleaned: false },
    { stoppedAndCleaned: null },
  ])
    expect(() =>
      planPaperReservationClosure({ ...f.input, terminal: { ...f.input.terminal, ...patch } }, now),
    ).toThrow();
});
it('확인·계획 hash 없이 쓰지 않으며 원본/증거 변경 시 처리와 기존 예외가 무효화된다', async () => {
  const f = await fixture(),
    plan = await f.store.inspect(f.runId, f.launchId);
  await expect(f.store.apply(f.runId, f.launchId, plan.hash, 'YES')).rejects.toThrow(
    'PAPER_CLOSURE_CONFIRMATION_REQUIRED',
  );
  await expect(f.store.apply(f.runId, f.launchId, '0'.repeat(64), 'RETIRE_ORPHANED_RESERVATION')).rejects.toThrow(
    'PAPER_CLOSURE_PLAN_CHANGED',
  );
  await f.store.apply(f.runId, f.launchId, plan.hash, 'RETIRE_ORPHANED_RESERVATION');
  await writeFile(join(f.folder, 'result.json'), JSON.stringify(f.input.terminal) + '\n');
  expect(
    await createPaperValidationStatus(join(f.root, '.local-data/paper-validation-runs'), () => now).checkReservations(),
  ).toMatchObject({ unresolvedCount: 1, retiredCount: 0 });
});
it('원본 파일 추가·symlink·크기 초과와 처리 파일 변조를 차단한다', async () => {
  const f = await fixture(),
    plan = await f.store.inspect(f.runId, f.launchId);
  await f.store.apply(f.runId, f.launchId, plan.hash, 'RETIRE_ORPHANED_RESERVATION');
  await writeFile(join(f.folder, 'request.json'), '{}');
  await expect(f.store.verify(f.runId)).rejects.toThrow();
  await rm(join(f.folder, 'request.json'));
  await rm(join(f.witness, 'exit.json'));
  await symlink(join(f.witness, 'launch.json'), join(f.witness, 'exit.json'));
  await expect(f.store.verify(f.runId)).rejects.toThrow();
  await rm(join(f.witness, 'exit.json'));
  await writeFile(join(f.witness, 'exit.json'), ' '.repeat(16385));
  await expect(f.store.verify(f.runId)).rejects.toThrow();
});

it('처리 기록과 소유 종료 증거 자체의 변경도 예외를 무효화한다', async () => {
  const f = await fixture(),
    plan = await f.store.inspect(f.runId, f.launchId);
  await f.store.apply(f.runId, f.launchId, plan.hash, 'RETIRE_ORPHANED_RESERVATION');
  const path = join(f.root, '.local-data/paper-reservation-closures', f.runId + '.json');
  const receipt = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, JSON.stringify({ ...receipt, exitHash: contentHash('changed') }));
  await expect(f.store.verify(f.runId)).rejects.toThrow();
  await writeFile(path, JSON.stringify(receipt));
  await writeFile(join(f.witness, 'exit.json'), JSON.stringify({ ...f.input.exit, exitCode: 2 }));
  await expect(f.store.verify(f.runId)).rejects.toThrow();
});

it.each(['new-file', 'new-bytes'])('증거를 읽는 도중 원본의 %s 변경이 생겨도 예외를 승인하지 않는다', async (kind) => {
  const f = await fixture(),
    plan = await f.store.inspect(f.runId, f.launchId);
  await f.store.apply(f.runId, f.launchId, plan.hash, 'RETIRE_ORPHANED_RESERVATION');
  mutation.current = async () => {
    if (kind === 'new-file') await writeFile(join(f.folder, 'request.json'), '{}');
    else await writeFile(join(f.folder, 'result.json'), JSON.stringify(f.input.terminal) + '\n');
  };
  await expect(f.store.verify(f.runId)).rejects.toThrow('PAPER_CLOSURE_SNAPSHOT_CHANGED');
  expect(
    await createPaperValidationStatus(join(f.root, '.local-data/paper-validation-runs'), () => now).checkReservations(),
  ).toMatchObject({ unresolvedCount: 1, retiredCount: 0 });
});
it('마이크로초 단위의 종료 증거/처리 시각 역전을 허용하지 않는다', async () => {
  const f = await fixture();
  const launch = { ...f.input.launch, startedAt: '2026-11-04T09:00:01.000900Z' };
  const terminal = { ...f.input.terminal, finishedAt: '2026-11-04T09:00:01.000100Z' };
  const body = { ...f.input.exit, launchHash: contentHash(launch), observedExitAt: '2026-11-04T09:00:01.000200Z' };
  Reflect.deleteProperty(body, 'hash');
  const exit = { ...body, hash: contentHash(body) };
  expect(() => planPaperReservationClosure({ ...f.input, launch, terminal, exit }, now)).toThrow();
  const validLaunch = { ...launch, startedAt: '2026-11-04T09:00:01.000000Z' };
  const exitBody = { ...body, launchHash: contentHash(validLaunch) };
  const validExit = { ...exitBody, hash: contentHash(exitBody) };
  const input = { ...f.input, launch: validLaunch, terminal, exit: validExit },
    plan = planPaperReservationClosure(input, now);
  const receiptBody = {
    formatVersion: 'paper-reservation-closure-v1',
    runId: plan.runId,
    launchId: plan.launchId,
    snapshotHash: plan.snapshotHash,
    launchHash: plan.launchHash,
    exitHash: plan.exitHash,
    terminalHash: plan.terminalHash,
    scope: plan.scope,
    historicalOutcomeVerified: false,
    createdAt: '2026-11-04T09:00:01.000100Z',
    executionEnabled: false,
    canResume: false,
  };
  expect(() => verifyPaperReservationClosure({ ...receiptBody, hash: contentHash(receiptBody) }, input, now)).toThrow();
});

it('원본에 정상 요청이 추가돼 과거 조회가 가능해져도 기존 처리 기록 변경을 무시하지 않는다', async () => {
  const f = await fixture(),
    plan = await f.store.inspect(f.runId, f.launchId);
  await f.store.apply(f.runId, f.launchId, plan.hash, 'RETIRE_ORPHANED_RESERVATION');
  await writeFile(
    join(f.folder, 'request.json'),
    JSON.stringify({
      formatVersion: 'authorized-paper-validation-v1',
      market: 'US',
      prerequisite: 'us-2026-11-03',
      startsAt: '2026-11-04T09:00:00Z',
      deadline: '2026-11-04T09:30:00Z',
      resumeRequested: true,
      maxTicks: 60,
      buildHash: contentHash('x'),
      automaticRetry: false,
      executionEnabled: false,
    }),
  );
  const reader = createPaperValidationStatus(join(f.root, '.local-data/paper-validation-runs'), () => now);
  expect(await reader.list()).toMatchObject({ rejectedCount: 0 });
  expect(await reader.checkReservations()).toMatchObject({ retiredCount: 0, unresolvedCount: 1 });
});
it('처리한 원본 폴더 삭제와 알 수 없는 처리 파일도 현재 예약 검사를 차단한다', async () => {
  const f = await fixture(),
    plan = await f.store.inspect(f.runId, f.launchId);
  await f.store.apply(f.runId, f.launchId, plan.hash, 'RETIRE_ORPHANED_RESERVATION');
  await rm(f.folder, { recursive: true });
  const reader = createPaperValidationStatus(join(f.root, '.local-data/paper-validation-runs'), () => now);
  expect(await reader.checkReservations()).toMatchObject({ retiredCount: 0, unresolvedCount: 1 });
  await writeFile(join(f.root, '.local-data/paper-reservation-closures', 'unknown.json'), '{}');
  expect(await reader.checkReservations()).toMatchObject({ retiredCount: 0, unresolvedCount: 2 });
});
