import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { contentHash } from '@hth/database';
import { observationArtifactSchema } from '@hth/contracts';
import type { ObservationChildLauncher } from './readonly-process-check.js';
import {
  readObservationText,
  findObservationFolder,
  fingerprintObservationBuild,
  manageObservationChild,
  waitWithin,
} from './readonly-process-check.js';
import { parseReadonlySupervisor } from './readonly-supervisor-config.js';
import { verifyObservationEvidence } from './observation-evidence.js';
import { verifyTokenLifecycleEvidence } from './token-lifecycle-evidence.js';
import { createPaperValidationStatus } from './paper-validation-status.js';
import { writeReviewArtifact } from './paper-review-files.js';

type Dependencies = {
  launch?: ObservationChildLauncher;
  outputRoot?: string;
  now?: () => number;
  pollMs?: number;
  graceMs?: number;
  killMs?: number;
};
export async function runReadonlySupervisor(
  args: string[],
  environment: Record<string, string | undefined>,
  root: string,
  signal: AbortSignal,
  dependencies: Dependencies = {},
) {
  const config = parseReadonlySupervisor(args, environment);
  const base = {
    service: 'readonly-observation-supervisor',
    source: config.source,
    executionEnabled: false,
    canResume: false,
    automaticRetry: false,
  };
  if (config.fingerprint) return { ...base, state: 'fingerprint', buildHash: await fingerprintObservationBuild(root) };
  // Bind instrument/source as well as timing. A plan checksum is not authorization.
  const binding = {
    plan: config.plan,
    source: config.source,
    instrument: config.instrument,
    ...(config.plan?.kind === 'regular' ? { observationJobId: config.observationJobId } : {}),
  };
  const planHash = contentHash(binding);
  if (!config.execute) return { ...base, state: 'preview', ...binding, planHash, scheduled: false };
  const plan = config.plan;
  if (
    !plan ||
    plan.state !== 'prepared' ||
    config.expectedPlanHash !== planHash ||
    !/^[a-f0-9]{64}$/.test(config.expectedBuildHash ?? '')
  )
    throw new Error('SUPERVISOR_PLAN_INVALID');
  const now = dependencies.now ?? Date.now;
  const start = Date.parse(plan.startsAt),
    deadline = Date.parse(plan.deadline),
    collectionCutoff = deadline - plan.cleanupAllowanceMs;
  let previousTime = now();
  const checkTime = () => {
    const current = now();
    if (!Number.isFinite(current) || current < previousTime) throw new Error('SUPERVISOR_CLOCK_CHANGED');
    previousTime = current;
    if (current >= collectionCutoff) throw new Error('SUPERVISOR_DEADLINE');
    signal.throwIfAborted();
    return current;
  };
  if (start - checkTime() > 36 * 3600000 || now() - start > 120000) throw new Error('SUPERVISOR_START_MISSED');
  if ((await fingerprintObservationBuild(root)) !== config.expectedBuildHash)
    throw new Error('SUPERVISOR_BUILD_CHANGED');
  const checkReservations = async () => {
    if (config.source !== 'market') return;
    const status = await createPaperValidationStatus(
      join(root, '.local-data/paper-validation-runs'),
      now,
    ).checkReservations();
    if (status.availability === 'unavailable' || status.limited || status.unresolvedCount > 0)
      throw new Error('SUPERVISOR_RESERVATIONS_UNVERIFIED');
    if (
      status.runs.some(
        (run) =>
          run.state === 'awaiting-result' &&
          Date.parse(run.deadline) > start &&
          (run.startsAt === null || Date.parse(run.startsAt) < deadline),
      )
    )
      throw new Error('SUPERVISOR_RESERVATION_CONFLICT');
  };
  await checkReservations();
  const id = randomUUID(),
    directory = join(dependencies.outputRoot ?? join(root, '.local-data/readonly-supervisions'), id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const parent = join(directory, 'observation');
  await mkdir(parent, { mode: 0o700 });
  await writeReviewArtifact(join(directory, 'request.json'), {
    formatVersion: 'readonly-supervision-request-v1',
    id,
    ...binding,
    planHash,
    buildHash: config.expectedBuildHash,
    requestedAt: new Date(now()).toISOString(),
    ...base,
  });
  let child: ReturnType<typeof manageObservationChild> | undefined;
  let forced = false,
    cleanupConfirmed = true,
    state = 'failed',
    code: string | null = null,
    stage = 'waiting';
  let evidence: {
    id: string;
    samples: number;
    healthy: number;
    closed: number;
    blocked: number;
    journalSha256: string;
  } | null = null;
  const stop = async () => {
    if (!child || child.read()) return;
    cleanupConfirmed = false;
    child.child.kill('SIGTERM');
    try {
      await waitWithin(child.done, dependencies.graceMs ?? 15000, 'SUPERVISOR_STOP_TIMEOUT');
    } catch {
      forced = true;
      child.child.kill('SIGKILL');
      await waitWithin(child.done, dependencies.killMs ?? 5000, 'SUPERVISOR_CLEANUP_UNCONFIRMED');
    }
    cleanupConfirmed = child.read()?.code === 0 && child.read()?.signal === null && !forced;
  };
  // This timer complements wall-clock polling; waking after OS suspension still checks the absolute deadline.
  const deadlineSignal = AbortSignal.timeout(Math.max(1, collectionCutoff - now()));
  const waitingSignal = AbortSignal.any([signal, deadlineSignal]);
  try {
    while (checkTime() < start) await delay(Math.min(1000, start - now()), undefined, { signal: waitingSignal });
    checkTime();
    if (now() - start > 120000) throw new Error('SUPERVISOR_START_MISSED');
    stage = 'preflight';
    await checkReservations();
    if ((await fingerprintObservationBuild(root)) !== config.expectedBuildHash)
      throw new Error('SUPERVISOR_BUILD_CHANGED');
    checkTime();
    if (now() - start > 120000) throw new Error('SUPERVISOR_START_MISSED');
    stage = 'observing';
    const argv = [
      ...(config.source === 'market' ? [`--env-file=${join(root, '.env')}`] : []),
      join(root, 'apps/worker/dist/market-observation-run.js'),
      `--output=${parent}`,
      `--samples=${plan.samples}`,
      `--interval-seconds=${plan.intervalSeconds}`,
      ...(config.source === 'demo'
        ? ['--demo']
        : [
            `--symbols=${config.instrument.market}:${config.instrument.symbol}`,
            '--share-dashboard',
            '--token-lifecycle',
            ...(plan.kind === 'regular' ? ['--regular-only'] : []),
            ...(plan.kind === 'session' ? [`--expected-session-boundary=${plan.boundaryAt}`] : []),
          ]),
    ];
    child = manageObservationChild(
      (dependencies.launch ?? spawn)(process.execPath, argv, {
        cwd: root,
        stdio: 'ignore',
        env: {
          TRADING_MODE: 'paper',
          NODE_ENV: 'development',
          PATH: environment.PATH,
          LANG: environment.LANG,
          TZ: environment.TZ,
        },
      }),
    );
    cleanupConfirmed = false;
    while (!child.read()) {
      checkTime();
      await Promise.race([child.done, delay(dependencies.pollMs ?? 250, undefined, { signal: waitingSignal })]);
    }
    checkTime();
    cleanupConfirmed = child.read()?.code === 0 && child.read()?.signal === null;
    if (!cleanupConfirmed) throw new Error('SUPERVISOR_CHILD_FAILED');
    stage = 'verify';
    const folder = await findObservationFolder(parent);
    if (!folder) throw new Error('SUPERVISOR_EVIDENCE_INVALID');
    const terminal = observationArtifactSchema.parse(
      JSON.parse(await readObservationText(join(folder, 'summary.json'), 262144)),
    );
    const verified = verifyObservationEvidence(
      JSON.parse(await readObservationText(join(folder, 'manifest.json'), 8192)),
      terminal,
      await readObservationText(join(folder, 'samples.jsonl'), 32 * 1048576),
    );
    if (
      Date.parse(verified.manifest.startedAt) < start ||
      Date.parse(terminal.finishedAt) > now() ||
      verified.manifest.id !== basename(folder) ||
      verified.manifest.samples !== plan.samples ||
      verified.manifest.intervalMs !== plan.intervalSeconds * 1000 ||
      verified.manifest.timeoutMs !== 10000 ||
      verified.manifest.source !== (config.source === 'demo' ? 'synthetic-only' : 'toss-readonly') ||
      contentHash(verified.manifest.instruments) !== contentHash([config.instrument]) ||
      verified.summary.status !== 'completed' ||
      verified.summary.errorSamples !== 0 ||
      (plan.kind === 'regular' &&
        (verified.summary.samples !== 60 ||
          verified.summary.healthy !== 60 ||
          verified.summary.closed !== 0 ||
          verified.summary.blocked !== 0 ||
          verified.summary.quoteRegressions !== 0 ||
          verified.records.some(
            (record, index) =>
              Date.parse(record.startedAt) < Date.parse(plan.sessionStartsAt!) ||
              Date.parse(record.finishedAt) >= Date.parse(plan.sessionEndsAt!) ||
              (index > 0 &&
                Date.parse(record.startedAt) - Date.parse(verified.records[index - 1]!.finishedAt) >
                  plan.intervalSeconds * 1000 + Math.max(30000, plan.intervalSeconds * 1000)),
          ))) ||
      verified.records.some(
        (record, index) =>
          Date.parse(record.startedAt) < start ||
          Date.parse(record.finishedAt) < Date.parse(record.startedAt) ||
          Date.parse(record.startedAt) < Date.parse(verified.manifest.startedAt) ||
          Date.parse(record.finishedAt) > Date.parse(terminal.finishedAt) ||
          Date.parse(record.finishedAt) >= deadline ||
          (index > 0 &&
            Date.parse(record.startedAt) <
              Date.parse(verified.records[index - 1]!.finishedAt) + plan.intervalSeconds * 1000),
      )
    )
      throw new Error('SUPERVISOR_EVIDENCE_INVALID');
    if (config.source === 'market') {
      const token = verifyTokenLifecycleEvidence(
        JSON.parse(await readObservationText(join(folder, 'token-lifecycle.json'), 131072)),
        verified.manifest,
      ).snapshot;
      if (
        token.clockUnverified ||
        token.limited ||
        token.inFlight !== 0 ||
        (plan.kind === 'regular' && (token.capturedAt === null || Date.parse(token.capturedAt) > now()))
      )
        throw new Error('SUPERVISOR_EVIDENCE_INVALID');
    }
    if ((await fingerprintObservationBuild(root)) !== config.expectedBuildHash)
      throw new Error('SUPERVISOR_BUILD_CHANGED');
    checkTime();
    evidence = {
      id: verified.manifest.id,
      samples: verified.summary.samples,
      healthy: verified.summary.healthy,
      closed: verified.summary.closed,
      blocked: verified.summary.blocked,
      journalSha256: verified.journalSha256,
    };
    state = 'observation-completed';
  } catch (error) {
    code = signal.aborted
      ? 'SUPERVISOR_CANCELLED'
      : deadlineSignal.aborted
        ? 'SUPERVISOR_DEADLINE'
        : error instanceof Error && /^SUPERVISOR_[A-Z_]+$/.test(error.message)
          ? error.message
          : 'SUPERVISOR_FAILED';
    try {
      await stop();
    } catch {
      cleanupConfirmed = false;
      code = 'SUPERVISOR_CLEANUP_UNCONFIRMED';
    }
    if (forced) code = 'SUPERVISOR_FORCED_STOP';
  }
  const result = {
    formatVersion: 'readonly-supervision-result-v1',
    id,
    ...base,
    state,
    stage,
    code,
    planHash,
    buildHash: config.expectedBuildHash,
    forced,
    childCleanupConfirmed: cleanupConfirmed,
    evidence,
    // Process/file verification cannot establish natural renewal, session transitions or Paper preservation.
    tokenExpiryVerified: false,
    sessionBoundaryVerified: false,
    paperLedgerCompared: false,
    finishedAt: new Date(now()).toISOString(),
  };
  await writeReviewArtifact(join(directory, 'result.json'), { ...result, hash: contentHash(result) });
  return result;
}
