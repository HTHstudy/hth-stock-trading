import { EventEmitter } from 'node:events';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { contentHash } from '@hth/database';
import { ownedPaperExitSchema, ownedPaperLaunchSchema } from './paper-reservation-closure-contracts.js';
import { parseOwnedPaperValidation, runOwnedPaperValidation } from './owned-paper-validation.js';
import { paperValidationRequestSchema } from './paper-validation-record-schema.js';

const roots: string[] = [];
const args = ['--execute', '--run', '--resume-authorized', '--market=US'];
const continuation = {
  parentRunId: '10c59018-398a-4d7c-a25b-1a9217810321',
  parentLaunchId: '20c59018-398a-4d7c-a25b-1a9217810321',
  evidenceHash: 'a'.repeat(64),
};
const continuationArgs = [
  `--continue-from=${continuation.parentRunId}`,
  `--continuation-launch=${continuation.parentLaunchId}`,
  `--continuation-hash=${continuation.evidenceHash}`,
];
const environment = {
  TRADING_MODE: 'paper',
  PATH: '/bin',
  LANG: 'C',
  TZ: 'UTC',
  NODE_OPTIONS: 'unsafe',
  TOSS_CLIENT_SECRET: 'secret',
};
async function fixture() {
  // macOS tmpdir may itself be an alias; the wrapper requires a canonical root.
  const { realpath } = await import('node:fs/promises');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'owned-paper-')));
  roots.push(root);
  await mkdir(join(root, 'infra'));
  await writeFile(join(root, 'infra/authorized-paper-validation.mjs'), '// synthetic runner, never executed');
  const child = new EventEmitter() as ChildProcess;
  child.kill = vi.fn(() => true);
  const launch = vi.fn<(node: string, args: string[], options: SpawnOptions) => ChildProcess>(() => child);
  return { root, child, launch, dependencies: { root, environment, launch } };
}
async function eventuallyLaunched(launch: ReturnType<typeof vi.fn>) {
  for (let count = 0; count < 400 && launch.mock.calls.length === 0; count++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  expect(launch).toHaveBeenCalledTimes(1);
}
async function artifacts(root: string) {
  const parent = join(root, '.local-data/paper-validation-processes');
  const [id] = await readdir(parent);
  const folder = join(parent, id!);
  const launch = ownedPaperLaunchSchema.parse(JSON.parse(await readFile(join(folder, 'launch.json'), 'utf8')));
  const exit = ownedPaperExitSchema.parse(JSON.parse(await readFile(join(folder, 'exit.json'), 'utf8')));
  return { folder, launch, exit };
}
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('owned Paper process evidence', () => {
  it.each([1, 2, 3, 4, 5, 6])('rejects partial continuation flags (mask %i)', (mask) => {
    const partial = continuationArgs.filter((_, index) => (mask & (1 << index)) !== 0);
    for (const prefix of [[], args]) {
      expect(() => parseOwnedPaperValidation([...prefix, ...partial], environment)).toThrow();
    }
  });
  it.each([
    ['--continue-from=bad', ...continuationArgs.slice(1)],
    [continuationArgs[0]!, '--continuation-launch=bad', continuationArgs[2]!],
    [...continuationArgs.slice(0, 2), '--continuation-hash=bad'],
    [...continuationArgs.slice(0, 2), `--continuation-hash=${'A'.repeat(64)}`],
    [...continuationArgs.slice(0, 2), `--continuation-hash=${'a'.repeat(63)}`],
    [...continuationArgs.slice(0, 2), `--continuation-hash=${'a'.repeat(65)}`],
    ['--continue-from=', ...continuationArgs.slice(1)],
    [...continuationArgs, continuationArgs[0]!],
    [...continuationArgs, `--run-id=${continuation.parentRunId}`],
  ])('rejects malformed, repeated, or caller-owned continuation arguments %j', (...invalid) => {
    expect(() => parseOwnedPaperValidation([...args, ...invalid], environment)).toThrow();
  });
  it.each([false, true])('inspects continuation offline with optional hash (%s)', async (withHash) => {
    const inspectArgs = ['--inspect-continuation', ...continuationArgs.slice(0, withHash ? 3 : 2)];
    expect(parseOwnedPaperValidation(inspectArgs, environment)).toEqual({
      execute: false,
      buildRoot: undefined,
      runnerArgs: inspectArgs,
    });
    const launch = vi.fn();
    expect(await runOwnedPaperValidation(inspectArgs, { root: '/does-not-exist', environment, launch })).toMatchObject({
      state: 'preview',
      executionEnabled: false,
      canResume: false,
    });
    expect(launch).not.toHaveBeenCalled();
  });
  it.each([
    [],
    [continuationArgs[0]!],
    [continuationArgs[1]!],
    [continuationArgs[2]!],
    [...continuationArgs, '--execute'],
    [...continuationArgs, '--run'],
    [...continuationArgs, '--resume-authorized'],
    [...continuationArgs, ...args],
    ['--continue-from=bad', ...continuationArgs.slice(1)],
    [...continuationArgs.slice(0, 2), '--continuation-hash=bad'],
  ])('rejects incomplete or execution-mixed continuation inspection %j', (...invalid) => {
    expect(() => parseOwnedPaperValidation(['--inspect-continuation', ...invalid], environment)).toThrow();
  });
  it.each([false, true])(
    'preserves all runner arguments and filtered environment (split strings %s)',
    async (split) => {
      const { root, child, launch, dependencies } = await fixture();
      const strings = [
        ...continuationArgs,
        '--prerequisite-supervision=89ab12cd-3456-4789-8abc-123456789012',
        '--build-hash=' + 'b'.repeat(64),
        '--resources=/offline/resources.json',
        '--resources-hash=' + 'c'.repeat(64),
        '--expectations=/offline/expectations.json',
        '--expectations-hash=' + 'd'.repeat(64),
        '--prerequisite=us-2026-11-09',
        '--start-at=2026-11-09T14:30:00Z',
        '--session-start=2026-11-09T14:30:00Z',
        '--session-end=2026-11-09T21:00:00Z',
        '--deadline=2026-11-09T15:00:00Z',
        `--build-root=${root}`,
      ];
      const forwarded = [...args.slice(1), ...strings.flatMap((value) => (split ? value.split('=') : [value]))];
      const running = runOwnedPaperValidation(['--execute', ...forwarded], dependencies);
      await eventuallyLaunched(launch);
      const [, actualArgs, options] = launch.mock.calls[0]!;
      child.emit('close', 0, null);
      expect(await running).toMatchObject({ successful: true });
      const { launch: record } = await artifacts(root);
      expect(actualArgs).toEqual([
        join(root, 'infra/authorized-paper-validation.mjs'),
        ...forwarded,
        `--run-id=${record.runId}`,
      ]);
      expect(record.argumentsHash).toBe(contentHash(actualArgs));
      expect(record.runId).not.toBe(continuation.parentRunId);
      expect(options.env).toEqual({ TRADING_MODE: 'paper', PATH: '/bin', LANG: 'C', TZ: 'UTC' });
      expect(launch).toHaveBeenCalledTimes(1);
    },
  );
  it('previews without filesystem, launcher, DB, or keys', async () => {
    const launch = vi.fn();
    expect(
      await runOwnedPaperValidation([], { root: '/does-not-exist', environment: { TRADING_MODE: 'paper' }, launch }),
    ).toMatchObject({ state: 'preview', executionEnabled: false, canResume: false });
    expect(launch).not.toHaveBeenCalled();
  });
  it.each([
    ['--execute'],
    ['--execute', '--run'],
    ['--execute', '--resume-authorized'],
    ['--run-id=bad'],
    ['--pid=123'],
    ['--run', '--run'],
    ['--market=US', '--market', 'KR'],
    ['positional'],
    ['--unknown'],
    ['--execute', '--run', '--resume-authorized', '--fingerprint'],
    ['--run', '--verify-inputs'],
    ['--resume-authorized', '--selfcheck-control'],
  ])('rejects invalid or mixed arguments %j', (...invalid) => {
    expect(() => parseOwnedPaperValidation(invalid, environment)).toThrow();
  });
  it('rejects live mode even in preview', () => {
    expect(() => parseOwnedPaperValidation([], { TRADING_MODE: 'live' })).toThrow();
  });
  it('records actual arguments, unique run binding, hashes, private files and filtered environment', async () => {
    const { root, child, launch, dependencies } = await fixture();
    const running = runOwnedPaperValidation(args, dependencies);
    await eventuallyLaunched(launch);
    const [node, actualArgs, options] = launch.mock.calls[0]!;
    expect(node).toBe(process.execPath);
    expect(options).toEqual({
      cwd: root,
      env: { TRADING_MODE: 'paper', PATH: '/bin', LANG: 'C', TZ: 'UTC' },
      stdio: 'ignore',
      shell: false,
      detached: false,
    });
    expect(actualArgs.filter((value) => value.startsWith('--run-id='))).toHaveLength(1);
    expect(actualArgs).not.toContain('--execute');
    child.emit('close', 0, null);
    expect(await running).toMatchObject({ state: 'exit-observed', successful: true });
    const { folder, launch: record, exit } = await artifacts(root);
    expect(record.argumentsHash).toBe(contentHash(actualArgs));
    expect(new Set([record.id, record.runId, record.nonce]).size).toBe(3);
    expect(actualArgs.at(-1)).toBe(`--run-id=${record.runId}`);
    expect(exit).toMatchObject({
      launchId: record.id,
      runId: record.runId,
      nonce: record.nonce,
      launchHash: contentHash(record),
      forced: false,
    });
    const { hash, ...body } = exit;
    expect(hash).toBe(contentHash(body));
    expect((await stat(folder)).mode & 0o777).toBe(0o700);
    for (const name of ['launch.json', 'exit.json']) expect((await stat(join(folder, name))).mode & 0o777).toBe(0o600);
    expect(await readdir(folder)).toEqual(['exit.json', 'launch.json']);
  });
  it('records a spawn error without exposing its message or retrying', async () => {
    const { root, child, launch, dependencies } = await fixture();
    const running = runOwnedPaperValidation(args, dependencies);
    await eventuallyLaunched(launch);
    child.emit('error', new Error('secret raw error'));
    expect(await running).toMatchObject({ successful: false });
    const { exit } = await artifacts(root);
    expect(exit.exitCode).toBeNull();
    expect(JSON.stringify(exit)).not.toContain('secret');
    expect(launch).toHaveBeenCalledTimes(1);
  });
  it('does not manufacture an exit while the child is running', async () => {
    const { root, child, launch, dependencies } = await fixture();
    const running = runOwnedPaperValidation(args, dependencies);
    await eventuallyLaunched(launch);
    const parent = join(root, '.local-data/paper-validation-processes');
    const [id] = await readdir(parent);
    expect(await readdir(join(parent, id!))).toEqual(['launch.json']);
    child.emit('close', 2, null);
    expect(await running).toMatchObject({ successful: false });
  });
  it('cancels only its own child and waits for observed close', async () => {
    const { root, child, launch, dependencies } = await fixture();
    const controller = new AbortController();
    const running = runOwnedPaperValidation(args, { ...dependencies, signal: controller.signal });
    await eventuallyLaunched(launch);
    controller.abort();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('close', null, 'SIGTERM');
    expect(await running).toMatchObject({ successful: false });
    expect((await artifacts(root)).exit).toMatchObject({ signal: 'SIGTERM', forced: false });
  });
  it('forces after 15 seconds and records forced failure', async () => {
    const { root, child, launch, dependencies } = await fixture();
    const controller = new AbortController();
    const running = runOwnedPaperValidation(args, { ...dependencies, signal: controller.signal });
    await eventuallyLaunched(launch);
    vi.useFakeTimers();
    controller.abort();
    await vi.advanceTimersByTimeAsync(14999);
    expect(child.kill).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenLastCalledWith('SIGKILL');
    child.emit('close', null, 'SIGKILL');
    expect(await running).toMatchObject({ successful: false });
    expect((await artifacts(root)).exit.forced).toBe(true);
  });
  it('fails after another five seconds without inventing exit evidence', async () => {
    const { root, launch, dependencies } = await fixture();
    const controller = new AbortController();
    const running = runOwnedPaperValidation(args, { ...dependencies, signal: controller.signal });
    const rejected = expect(running).rejects.toThrow('OWNED_PAPER_EXIT_UNOBSERVED');
    await eventuallyLaunched(launch);
    vi.useFakeTimers();
    controller.abort();
    await vi.advanceTimersByTimeAsync(20000);
    await rejected;
    const parent = join(root, '.local-data/paper-validation-processes');
    const [id] = await readdir(parent);
    expect(await readdir(join(parent, id!))).toEqual(['launch.json']);
  });
  it('marks a reversed clock unverified', async () => {
    const { root, child, launch, dependencies } = await fixture();
    let time = Date.now();
    const running = runOwnedPaperValidation(args, { ...dependencies, now: () => time });
    await eventuallyLaunched(launch);
    time -= 1000;
    child.emit('close', 0, null);
    expect(await running).toMatchObject({ successful: false });
    expect((await artifacts(root)).exit.clockUnverified).toBe(true);
  });
  it('rejects symlink storage without launching', async () => {
    const { root, launch, dependencies } = await fixture();
    await mkdir(join(root, 'other'));
    await symlink(join(root, 'other'), join(root, '.local-data'));
    await expect(runOwnedPaperValidation(args, dependencies)).rejects.toThrow();
    expect(launch).not.toHaveBeenCalled();
  });
  it('waits for close when an already spawned child reports an error', async () => {
    const { root, child, launch, dependencies } = await fixture();
    Object.defineProperty(child, 'pid', { value: 123 });
    const running = runOwnedPaperValidation(args, dependencies);
    await eventuallyLaunched(launch);
    child.emit('error', new Error('synthetic kill error'));
    const parent = join(root, '.local-data/paper-validation-processes');
    const [id] = await readdir(parent);
    expect(await readdir(join(parent, id!))).toEqual(['launch.json']);
    child.emit('close', 0, null);
    expect(await running).toMatchObject({ successful: false });
  });
  it('preserves existing launch evidence without overwriting or launching', async () => {
    const { root, launch, dependencies } = await fixture();
    const ids = [
      '30c59018-398a-4d7c-a25b-1a9217810321',
      '10c59018-398a-4d7c-a25b-1a9217810321',
      '20c59018-398a-4d7c-a25b-1a9217810321',
    ];
    const old = join(root, '.local-data/paper-validation-processes', ids[0]!);
    await mkdir(old, { recursive: true });
    await writeFile(join(old, 'launch.json'), 'original');
    await expect(runOwnedPaperValidation(args, { ...dependencies, uuid: () => ids.shift()! })).rejects.toThrow();
    expect(await readFile(join(old, 'launch.json'), 'utf8')).toBe('original');
    expect(launch).not.toHaveBeenCalled();
  });
  it('does not launch after pre-launch cancellation', async () => {
    const { root, launch, dependencies } = await fixture();
    await expect(runOwnedPaperValidation(args, { ...dependencies, signal: AbortSignal.abort() })).rejects.toThrow();
    const parent = join(root, '.local-data/paper-validation-processes');
    const [id] = await readdir(parent);
    expect(await readdir(join(parent, id!))).toEqual(['launch.json']);
    expect(launch).not.toHaveBeenCalled();
  });
  it('rejects a symlink runner without starting a child', async () => {
    const { root, launch, dependencies } = await fixture();
    const runner = join(root, 'infra/authorized-paper-validation.mjs');
    await rm(runner);
    await writeFile(join(root, 'other.mjs'), '// not executed');
    await symlink(join(root, 'other.mjs'), runner);
    await expect(runOwnedPaperValidation(args, dependencies)).rejects.toThrow();
    expect(launch).not.toHaveBeenCalled();
  });
  it('rejects reused run IDs without touching the old directory', async () => {
    const { root, launch, dependencies } = await fixture();
    const ids = [
      '30c59018-398a-4d7c-a25b-1a9217810321',
      '10c59018-398a-4d7c-a25b-1a9217810321',
      '20c59018-398a-4d7c-a25b-1a9217810321',
    ];
    const old = join(root, '.local-data/paper-validation-runs', ids[1]!);
    await mkdir(old, { recursive: true });
    await writeFile(join(old, 'result.json'), 'old');
    await expect(runOwnedPaperValidation(args, { ...dependencies, uuid: () => ids.shift()! })).rejects.toThrow();
    expect(await readFile(join(old, 'result.json'), 'utf8')).toBe('old');
    expect(launch).not.toHaveBeenCalled();
  });
});

describe('Paper validation request continuation schema', () => {
  const request = {
    formatVersion: 'authorized-paper-validation-v1',
    market: 'US',
    prerequisite: 'us-2026-11-09',
    startsAt: null,
    deadline: '2026-11-09T15:00:00Z',
    resumeRequested: true,
    maxTicks: 60,
    buildHash: 'b'.repeat(64),
    automaticRetry: false,
    executionEnabled: false,
  };
  it('preserves pristine requests and accepts a complete strict continuation', () => {
    expect(paperValidationRequestSchema.parse(request)).toEqual(request);
    expect(paperValidationRequestSchema.parse({ ...request, continuation })).toEqual({ ...request, continuation });
    expect(paperValidationRequestSchema.safeParse({ ...request, unknown: true }).success).toBe(false);
  });
  it.each([
    null,
    {},
    { parentRunId: continuation.parentRunId, parentLaunchId: continuation.parentLaunchId },
    { parentRunId: continuation.parentRunId, evidenceHash: continuation.evidenceHash },
    { parentLaunchId: continuation.parentLaunchId, evidenceHash: continuation.evidenceHash },
    { ...continuation, parentRunId: 'bad' },
    { ...continuation, parentLaunchId: 'bad' },
    { ...continuation, evidenceHash: 'A'.repeat(64) },
    { ...continuation, evidenceHash: 'a'.repeat(63) },
    { ...continuation, unknown: true },
  ])('rejects malformed or extended continuation %j', (invalid) => {
    expect(paperValidationRequestSchema.safeParse({ ...request, continuation: invalid }).success).toBe(false);
  });
});

it('고정 build-root의 runner를 사용해도 환경/작업/증거 root는 원래 workspace에 둔다', async () => {
  const f = await fixture(),
    code = await fixture();
  const work = runOwnedPaperValidation([...args, `--build-root=${code.root}`], f.dependencies);
  await eventuallyLaunched(f.launch);
  const call = f.launch.mock.calls[0]!;
  expect(call[1][0]).toBe(join(code.root, 'infra/authorized-paper-validation.mjs'));
  expect(call[2].cwd).toBe(f.root);
  f.child.emit('close', 1, null);
  await work;
  expect((await artifacts(f.root)).launch.runnerHash).toHaveLength(64);
  await expect(readdir(join(code.root, '.local-data'))).rejects.toMatchObject({ code: 'ENOENT' });
});
