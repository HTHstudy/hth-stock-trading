import { spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { parseArgs } from 'node:util';
import type { ParseArgsConfig } from 'node:util';
import { contentHash } from '@hth/database';
import { ownedPaperExitSchema, ownedPaperLaunchSchema } from './paper-reservation-closure-contracts.js';

const stringFlags = [
  'market',
  'build-root',
  'build-hash',
  'prerequisite',
  'start-at',
  'session-start',
  'session-end',
  'deadline',
  'resources',
  'resources-hash',
  'expectations',
  'expectations-hash',
] as const;
const booleanFlags = [
  'execute',
  'run',
  'resume-authorized',
  'fingerprint',
  'verify-inputs',
  'selfcheck-control',
] as const;
const fail = () => new Error('OWNED_PAPER_VALIDATION_INVALID');

export function parseOwnedPaperValidation(args: string[], environment: Record<string, string | undefined>) {
  if (environment.TRADING_MODE !== 'paper') throw fail();
  const options: NonNullable<ParseArgsConfig['options']> = Object.fromEntries([
    ...stringFlags.map((key) => [key, { type: 'string' as const }]),
    ...booleanFlags.map((key) => [key, { type: 'boolean' as const }]),
  ]);
  const { values, tokens } = parseArgs({ args, options, tokens: true, strict: true, allowPositionals: false });
  const seen = new Set<string>();
  for (const token of tokens) {
    if (token.kind !== 'option' || seen.has(token.name)) throw fail();
    seen.add(token.name);
  }
  const execute = values.execute === true;
  if (execute && (!values.run || !values['resume-authorized'])) throw fail();
  const inspect = ['fingerprint', 'verify-inputs', 'selfcheck-control'].some((key) => values[key]);
  if (inspect && (execute || values.run || values['resume-authorized'])) throw fail();
  if (execute && !['KR', 'US'].includes(String(values.market))) throw fail();
  const buildRoot = values['build-root'];
  if (buildRoot !== undefined && typeof buildRoot !== 'string') throw fail();
  return { execute, buildRoot, runnerArgs: args.filter((argument) => argument !== '--execute') };
}

type Dependencies = {
  root: string;
  environment: Record<string, string | undefined>;
  launch?: (node: string, args: string[], options: SpawnOptions) => ChildProcess;
  now?: () => number;
  uuid?: () => string;
  signal?: AbortSignal;
};

async function privateDirectory(path: string) {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(path)) !== path) throw fail();
}

async function writeNew(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await link(temporary, path);
  } finally {
    await unlink(temporary);
  }
}

async function runnerDigest(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 1048576) throw fail();
    const bytes = await file.readFile();
    if (bytes.length > 1048576) throw fail();
    return createHash('sha256').update(bytes).digest('hex');
  } finally {
    await file.close();
  }
}

/** Only trusted server configuration may supply root, arguments, or dependencies. Never attach to a PID. */
export async function runOwnedPaperValidation(args: string[], dependencies: Dependencies) {
  const config = parseOwnedPaperValidation(args, dependencies.environment);
  if (!config.execute) return { state: 'preview', executionEnabled: false, canResume: false, automaticRetry: false };
  const { root } = dependencies;
  if (!isAbsolute(root) || (await realpath(root)) !== root) throw fail();
  const now = dependencies.now ?? Date.now;
  const uuid = dependencies.uuid ?? randomUUID;
  const started = now();
  const id = uuid(),
    runId = uuid(),
    nonce = uuid();
  if (new Set([id, runId, nonce]).size !== 3) throw fail();
  const codeRoot = config.buildRoot ?? root;
  if (!isAbsolute(codeRoot) || (await realpath(codeRoot)) !== codeRoot) throw fail();
  const runner = join(codeRoot, 'infra/authorized-paper-validation.mjs');
  if ((await realpath(join(codeRoot, 'infra'))) !== join(codeRoot, 'infra')) throw fail();
  const actualArgs = [runner, ...config.runnerArgs, `--run-id=${runId}`];
  const launch = ownedPaperLaunchSchema.parse({
    formatVersion: 'owned-paper-launch-v1',
    id,
    runId,
    nonce,
    runnerHash: await runnerDigest(runner),
    argumentsHash: contentHash(actualArgs),
    startedAt: new Date(started).toISOString(),
    automaticRetry: false,
    executionEnabled: false,
    canResume: false,
  });
  // Never reuse a run directory; only the runner creates it after its own input validation.
  try {
    await lstat(join(root, '.local-data/paper-validation-runs', runId));
    throw fail();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await privateDirectory(join(root, '.local-data'));
  await privateDirectory(join(root, '.local-data/paper-validation-processes'));
  const directory = join(root, '.local-data/paper-validation-processes', id);
  await mkdir(directory, { mode: 0o700 });
  await writeNew(join(directory, 'launch.json'), launch);
  if (dependencies.signal?.aborted || (await runnerDigest(runner)) !== launch.runnerHash) throw fail();
  const environment: NodeJS.ProcessEnv = { TRADING_MODE: 'paper' };
  for (const key of ['PATH', 'LANG', 'TZ']) {
    const value = dependencies.environment[key];
    if (value !== undefined) environment[key] = value;
  }
  const child = (dependencies.launch ?? spawn)(process.execPath, actualArgs, {
    cwd: root,
    env: environment,
    stdio: 'ignore',
    shell: false,
    detached: false,
  });
  let forced = false,
    cancelled = false,
    spawnFailed = false,
    settled = false;
  let grace: ReturnType<typeof setTimeout> | undefined;
  let hard: ReturnType<typeof setTimeout> | undefined;
  let observed = started;
  let clockUnverified = false;
  const clock = () => {
    const value = now();
    if (!Number.isFinite(value) || value < observed) clockUnverified = true;
    if (Number.isFinite(value)) observed = value;
  };
  const kill = (signal: NodeJS.Signals) => {
    try {
      child.kill(signal);
    } catch {
      /* Await own close/error only. */
    }
  };
  let rejectTimeout: (() => void) | undefined;
  const stop = () => {
    if (cancelled || settled) return;
    cancelled = true;
    clock();
    kill('SIGTERM');
    grace = setTimeout(() => {
      if (settled) return;
      forced = true;
      clock();
      kill('SIGKILL');
      hard = setTimeout(() => rejectTimeout?.(), 5000);
    }, 15000);
  };
  try {
    const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      rejectTimeout = () => reject(new Error('OWNED_PAPER_EXIT_UNOBSERVED'));
      child.once('error', () => {
        spawnFailed = true;
        if (child.pid !== undefined) return;
        settled = true;
        clock();
        resolve({ code: null, signal: null });
      });
      child.once('close', (code, signal) => {
        settled = true;
        clock();
        resolve({ code, signal });
      });
      dependencies.signal?.addEventListener('abort', stop, { once: true });
      if (dependencies.signal?.aborted) stop();
    });
    const supportedSignal = outcome.signal === null || ['SIGTERM', 'SIGINT', 'SIGKILL'].includes(outcome.signal);
    const body = {
      formatVersion: 'owned-paper-exit-v1' as const,
      launchId: id,
      runId,
      nonce,
      launchHash: contentHash(launch),
      exitCode: outcome.code,
      signal: supportedSignal ? outcome.signal : null,
      forced,
      clockUnverified: clockUnverified || !supportedSignal,
      observedExitAt: new Date(observed).toISOString(),
      executionEnabled: false as const,
      canResume: false as const,
    };
    const exit = ownedPaperExitSchema.parse({ ...body, hash: contentHash(body) });
    await writeNew(join(directory, 'exit.json'), exit);
    return {
      state: 'exit-observed',
      launchId: id,
      runId,
      successful:
        !spawnFailed && !cancelled && !forced && !exit.clockUnverified && outcome.code === 0 && outcome.signal === null,
      executionEnabled: false,
      canResume: false,
      automaticRetry: false,
    };
  } finally {
    if (grace) clearTimeout(grace);
    if (hard) clearTimeout(hard);
    dependencies.signal?.removeEventListener('abort', stop);
  }
}
