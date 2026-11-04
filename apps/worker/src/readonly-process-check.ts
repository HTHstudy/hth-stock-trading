import { spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, opendir, lstat, realpath, readdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { paperModeSchema, observationManifestSchema, observationRecordSchema } from '@hth/contracts';
import { contentHash } from '@hth/database';
import { parseReadonlySymbols } from './readonly-config.js';
import { verifyObservationEvidence } from './observation-evidence.js';
import { verifyTokenLifecycleEvidence } from './token-lifecycle-evidence.js';
import { writeReviewArtifact } from './paper-review-files.js';

export function parseReadonlyProcessCheck(args: string[], environment: Record<string, string | undefined>) {
  paperModeSchema.parse(environment.TRADING_MODE);
  const { values } = parseArgs({
    args,
    options: {
      execute: { type: 'boolean', default: false },
      kind: { type: 'string', default: 'demo' },
      symbol: { type: 'string' },
    },
  });
  const kind = z.enum(['demo', 'market']).parse(values.kind);
  if (kind === 'demo' && values.symbol !== undefined) throw new Error('PROCESS_CHECK_CONFIG_INVALID');
  const instruments = parseReadonlySymbols(kind === 'demo' ? 'KR:005930' : values.symbol);
  if (instruments.length !== 1 || (kind === 'market' && !values.symbol))
    throw new Error('PROCESS_CHECK_CONFIG_INVALID');
  return { execute: values.execute, kind, instrument: instruments[0]! };
}
async function boundedText(path: string, limit: number) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > limit) throw new Error('PROCESS_CHECK_EVIDENCE_INVALID');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const part of file.createReadStream({ autoClose: false, start: 0, end: limit })) {
      const chunk = part as Buffer;
      size += chunk.length;
      if (size > limit) throw new Error('PROCESS_CHECK_EVIDENCE_INVALID');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    await file.close();
  }
}
async function runFolder(parent: string) {
  const info = await lstat(parent);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('PROCESS_CHECK_EVIDENCE_INVALID');
  const canonical = await realpath(parent);
  let folder: string | undefined;
  for await (const entry of await opendir(parent)) {
    if (folder || !z.uuid().safeParse(entry.name).success || !entry.isDirectory() || entry.isSymbolicLink())
      throw new Error('PROCESS_CHECK_EVIDENCE_INVALID');
    folder = join(parent, entry.name);
    if ((await realpath(folder)) !== join(canonical, entry.name)) throw new Error('PROCESS_CHECK_EVIDENCE_INVALID');
  }
  return folder;
}
async function fingerprint(root: string) {
  const files: string[] = [];
  for (const relative of [
    'apps/worker/dist',
    'packages/contracts/dist',
    'packages/broker/dist',
    'packages/trading/dist',
    'packages/database/dist',
  ]) {
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
        if (entry.isSymbolicLink()) throw new Error('PROCESS_CHECK_BUILD_CHANGED');
        if (entry.isDirectory()) await walk(join(directory, entry.name));
        else if (entry.name.endsWith('.js')) files.push(join(directory, entry.name));
      }
    };
    await walk(relative);
  }
  files.push('pnpm-lock.yaml');
  files.sort();
  const values = [];
  for (const path of files) values.push([path, await boundedText(join(root, path), 4 * 1048576)]);
  return contentHash(values);
}
type Exit = { code: number | null; signal: NodeJS.Signals | null; spawnFailed: boolean };
function managed(child: ChildProcess) {
  let outcome: Exit | null = null;
  const done = new Promise<Exit>((resolve) => {
    child.once('error', () => {
      outcome = { code: null, signal: null, spawnFailed: true };
      resolve(outcome);
    });
    child.once('close', (code, signal) => {
      outcome ??= { code, signal, spawnFailed: false };
      resolve(outcome);
    });
  });
  return { child, done, read: () => outcome };
}
async function within<T>(promise: Promise<T>, ms: number, code: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(code)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export type ObservationChildLauncher = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

type Dependencies = {
  outputRoot?: string;
  launch?: ObservationChildLauncher;
  firstTimeoutMs?: number;
  secondTimeoutMs?: number;
  graceMs?: number;
  killMs?: number;
};

export async function runReadonlyProcessCheck(
  args: string[],
  environment: Record<string, string | undefined>,
  root: string,
  signal: AbortSignal,
  dependencies: Dependencies = {},
) {
  const config = parseReadonlyProcessCheck(args, environment);
  const base = {
    service: 'readonly-process-check',
    kind: config.kind,
    executionEnabled: false,
    canResume: false,
    automaticRetry: false,
  };
  if (!config.execute) return { ...base, state: 'preview', maxChildren: 2 };
  signal.throwIfAborted();
  const buildHash = await fingerprint(root);
  signal.throwIfAborted();
  const id = randomUUID(),
    directory = join(dependencies.outputRoot ?? join(root, '.local-data/readonly-process-checks'), id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const firstParent = join(directory, 'first'),
    secondParent = join(directory, 'second');
  await mkdir(firstParent, { mode: 0o700 });
  await mkdir(secondParent, { mode: 0o700 });
  let current: ReturnType<typeof managed> | undefined,
    forced = false,
    stage = 'first';
  let first: ReturnType<typeof verifyObservationEvidence> | undefined, second: typeof first;
  let firstPid: number | undefined;
  const launch = dependencies.launch ?? spawn;
  const start = (parent: string, samples: number) => {
    const argv = [
      ...(config.kind === 'market' ? [`--env-file=${join(root, '.env')}`] : []),
      join(root, 'apps/worker/dist/market-observation-run.js'),
      `--output=${parent}`,
      `--samples=${samples}`,
      '--interval-seconds=60',
      ...(config.kind === 'demo'
        ? ['--demo']
        : [
            `--symbols=${config.instrument.market}:${config.instrument.symbol}`,
            '--share-dashboard',
            '--token-lifecycle',
          ]),
    ];
    // Do not inherit keys, NODE_OPTIONS, owner sessions, or Paper configuration.
    const env = {
      PATH: environment.PATH,
      LANG: environment.LANG,
      TZ: environment.TZ,
      TRADING_MODE: 'paper',
      NODE_ENV: 'development',
    };
    return managed(launch(process.execPath, argv, { cwd: root, env, stdio: 'ignore' }));
  };
  const stop = async () => {
    if (!current || current.read()) return;
    current.child.kill('SIGTERM');
    try {
      await within(current.done, dependencies.graceMs ?? 15000, 'PROCESS_CHECK_STOP_TIMEOUT');
    } catch {
      forced = true;
      current.child.kill('SIGKILL');
      await within(current.done, dependencies.killMs ?? 5000, 'PROCESS_CHECK_CLEANUP_UNCONFIRMED');
    }
  };
  const readFinal = async (parent: string, expected: 'cancelled' | 'completed') => {
    const folder = await runFolder(parent);
    if (!folder) throw new Error('PROCESS_CHECK_EVIDENCE_INVALID');
    const evidence = verifyObservationEvidence(
      JSON.parse(await boundedText(join(folder, 'manifest.json'), 8192)),
      JSON.parse(await boundedText(join(folder, 'summary.json'), 262144)),
      await boundedText(join(folder, 'samples.jsonl'), 65536),
    );
    if (
      evidence.manifest.id !== basename(folder) ||
      evidence.summary.status !== expected ||
      evidence.summary.samples !== 1 ||
      evidence.summary.errorSamples !== 0 ||
      evidence.manifest.samples !== (expected === 'cancelled' ? 2 : 1) ||
      evidence.manifest.source !== (config.kind === 'demo' ? 'synthetic-only' : 'toss-readonly') ||
      contentHash(evidence.manifest.instruments) !== contentHash([config.instrument])
    )
      throw new Error('PROCESS_CHECK_EVIDENCE_INVALID');
    if (config.kind === 'market') {
      const token = verifyTokenLifecycleEvidence(
        JSON.parse(await boundedText(join(folder, 'token-lifecycle.json'), 131072)),
        evidence.manifest,
      ).snapshot;
      if (token.clockUnverified || token.limited || token.inFlight !== 0 || token.counters.initial.succeeded !== 1)
        throw new Error('PROCESS_CHECK_EVIDENCE_INVALID');
    }
    return evidence;
  };
  let state = 'failed',
    code: string | null = null;
  try {
    signal.throwIfAborted();
    current = start(firstParent, 2);
    firstPid = current.child.pid;
    const end = performance.now() + (dependencies.firstTimeoutMs ?? 30000);
    while (true) {
      signal.throwIfAborted();
      if (current.read()) throw new Error('PROCESS_CHECK_FIRST_EXITED_EARLY');
      const folder = await runFolder(firstParent);
      if (folder) {
        let manifest: unknown;
        try {
          manifest = JSON.parse(await boundedText(join(folder, 'manifest.json'), 8192));
        } catch (error) {
          if (
            !(error instanceof SyntaxError) &&
            !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
          )
            throw error;
        }
        if (manifest) {
          observationManifestSchema.parse(manifest);
          const journal = await boundedText(join(folder, 'samples.jsonl'), 65536).catch((error) => {
            if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return '';
            throw error;
          });
          const newline = journal.indexOf('\n');
          if (newline >= 0) {
            const record = observationRecordSchema.parse(JSON.parse(journal.slice(0, newline)));
            if (record.index !== 1 || record.error !== null) throw new Error('PROCESS_CHECK_EVIDENCE_INVALID');
            break;
          }
        }
      }
      if (performance.now() >= end) throw new Error('PROCESS_CHECK_FIRST_TIMEOUT');
      await delay(50, undefined, { signal });
    }
    stage = 'stop';
    await stop();
    if (forced || current.read()?.code !== 0 || current.read()?.signal !== null)
      throw new Error('PROCESS_CHECK_NOT_GRACEFUL');
    stage = 'verify-first';
    first = await readFinal(firstParent, 'cancelled');
    signal.throwIfAborted();
    if ((await fingerprint(root)) !== buildHash) throw new Error('PROCESS_CHECK_BUILD_CHANGED');
    signal.throwIfAborted();
    stage = 'second';
    current = start(secondParent, 1);
    if (current.child.pid === firstPid || !current.child.pid) throw new Error('PROCESS_CHECK_CHILD_INVALID');
    let onAbort = () => {};
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error('PROCESS_CHECK_CANCELLED'));
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    try {
      await within(
        Promise.race([current.done, cancelled]),
        dependencies.secondTimeoutMs ?? 30000,
        'PROCESS_CHECK_SECOND_TIMEOUT',
      );
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
    signal.throwIfAborted();
    if (current.read()?.code !== 0 || current.read()?.signal !== null) throw new Error('PROCESS_CHECK_SECOND_FAILED');
    stage = 'verify-second';
    second = await readFinal(secondParent, 'completed');
    if ((await fingerprint(root)) !== buildHash) throw new Error('PROCESS_CHECK_BUILD_CHANGED');
    signal.throwIfAborted();
    state = 'verified';
  } catch (error) {
    code = signal.aborted
      ? 'PROCESS_CHECK_CANCELLED'
      : error instanceof Error && /^PROCESS_CHECK_[A-Z_]+$/.test(error.message)
        ? error.message
        : 'PROCESS_CHECK_FAILED';
    try {
      await stop();
    } catch {
      code = 'PROCESS_CHECK_CLEANUP_UNCONFIRMED';
    }
  }
  const evidence = (value: typeof first) =>
    value
      ? {
          id: value.manifest.id,
          status: value.summary.status,
          samples: value.summary.samples,
          journalSha256: value.journalSha256,
          healthy: value.summary.healthy,
          closed: value.summary.closed,
          blocked: value.summary.blocked,
        }
      : null;
  const result = {
    formatVersion: 'readonly-process-check-v1',
    ...base,
    id,
    state,
    code,
    stage,
    buildHash,
    forced,
    first: evidence(first),
    second: evidence(second),
    paperLedgerCompared: false,
    tokenExpiryVerified: false,
  };
  await writeReviewArtifact(join(directory, 'result.json'), { ...result, hash: contentHash(result) });
  return result;
}

// Internal worker reuse: bounded evidence reads and handles for children we own.
export {
  boundedText as readObservationText,
  runFolder as findObservationFolder,
  fingerprint as fingerprintObservationBuild,
  managed as manageObservationChild,
  within as waitWithin,
};
