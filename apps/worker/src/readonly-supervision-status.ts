import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { observationJobSchema } from '@hth/contracts';
import { contentHash } from '@hth/database';
import { marketTradingDate } from '@hth/trading';
import { planReadonlyValidation } from './readonly-validation-plan.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const instant = z.iso.datetime({ offset: true });
const count = z.number().int().min(0).max(10_000);
const source = z.enum(['demo', 'market']);
const safety = {
  executionEnabled: z.literal(false),
  canResume: z.literal(false),
  automaticRetry: z.literal(false),
};
const instrument = z.strictObject({
  market: z.enum(['KR', 'US']),
  symbol: z.string().regex(/^[A-Z0-9.-]{1,40}$/),
});
const planSchema = z.strictObject({
  formatVersion: z.literal('readonly-validation-plan-v1'),
  kind: z.enum(['session', 'expiry', 'regular']),
  state: z.literal('prepared'),
  startsAt: instant,
  deadline: instant,
  targetThrough: instant,
  samples: count.min(2),
  intervalSeconds: z.number().int().min(10).max(3600),
  sampleTimeoutMs: z.literal(10_000),
  minimumSamplingSpanMs: z.number().int().nonnegative(),
  startupAllowanceMs: z.literal(30_000),
  cleanupAllowanceMs: z.literal(60_000),
  plannedBudgetMs: z.number().int().positive(),
  estimatedBudgetEndsAt: instant,
  sourceMethodCallsWithoutRetries: z.number().int().min(10).max(50_000),
  httpRequestCountKnown: z.literal(false),
  blockers: z
    .array(z.enum(['DEADLINE_BUDGET_INSUFFICIENT', 'RESERVED_WINDOW_OVERLAP', 'OUTSIDE_REGULAR_SESSION']))
    .length(0),
  reservedWindowCount: z.number().int().min(0).max(100),
  reservedWindows: z.array(z.strictObject({ startsAt: instant, endsAt: instant })).max(100),
  observedTtlSeconds: z.number().int().min(1).max(172800).nullable(),
  boundaryAt: instant.nullable(),
  regularOnly: z.boolean(),
  sessionStartsAt: instant.optional(),
  sessionEndsAt: instant.optional(),
  tokenLifecycle: z.literal(true),
  requiresDeadlineSupervisor: z.literal(true),
  requiresFreshCalendar: z.literal(true),
  requiresActualTtlReview: z.boolean(),
  scheduled: z.literal(false),
  executionEnabled: z.literal(false),
  canResume: z.literal(false),
});
const requestSchema = z.strictObject({
  formatVersion: z.literal('readonly-supervision-request-v1'),
  id: z.uuid(),
  service: z.literal('readonly-observation-supervisor'),
  source,
  plan: planSchema,
  instrument,
  planHash: hash,
  buildHash: hash,
  requestedAt: instant,
  observationJobId: observationJobSchema.shape.id.optional(),
  ...safety,
});
const failureCode = z.enum([
  'SUPERVISOR_BUILD_CHANGED',
  'SUPERVISOR_CANCELLED',
  'SUPERVISOR_CHILD_FAILED',
  'SUPERVISOR_CLEANUP_UNCONFIRMED',
  'SUPERVISOR_CLOCK_CHANGED',
  'SUPERVISOR_DEADLINE',
  'SUPERVISOR_EVIDENCE_INVALID',
  'SUPERVISOR_FAILED',
  'SUPERVISOR_FORCED_STOP',
  'SUPERVISOR_PLAN_INVALID',
  'SUPERVISOR_RESERVATIONS_UNVERIFIED',
  'SUPERVISOR_RESERVATION_CONFLICT',
  'SUPERVISOR_START_MISSED',
  'SUPERVISOR_STOP_TIMEOUT',
]);
const resultSchema = z.strictObject({
  formatVersion: z.literal('readonly-supervision-result-v1'),
  id: z.uuid(),
  service: z.literal('readonly-observation-supervisor'),
  source,
  state: z.enum(['observation-completed', 'failed']),
  stage: z.enum(['waiting', 'preflight', 'observing', 'verify']),
  code: failureCode.nullable(),
  planHash: hash,
  buildHash: hash,
  forced: z.boolean(),
  childCleanupConfirmed: z.boolean(),
  evidence: z
    .strictObject({
      id: z.uuid(),
      samples: count.min(1),
      healthy: count,
      closed: count,
      blocked: count,
      journalSha256: hash,
    })
    .nullable(),
  tokenExpiryVerified: z.literal(false),
  sessionBoundaryVerified: z.literal(false),
  paperLedgerCompared: z.literal(false),
  finishedAt: instant,
  ...safety,
  hash,
});

const boundaries = {
  executionEnabled: false,
  canResume: false,
  automaticRetry: false,
  processLivenessChecked: false,
  observationEvidenceRecomputed: false,
  currentBuildChecked: false,
  tokenExpiryVerified: false,
  sessionBoundaryVerified: false,
  paperLedgerCompared: false,
} as const;

/** Validates saved metadata only; never reads observations or recalculates operational approval. */
export function summarizeReadonlySupervision(id: string, input: { request: unknown; result: unknown }, now: number) {
  z.uuid().parse(id);
  const request = requestSchema.parse(input.request);
  const plan = request.plan;
  const recalculated = planReadonlyValidation({
    kind: plan.kind,
    startsAt: plan.startsAt,
    deadline: plan.deadline,
    intervalSeconds: plan.intervalSeconds,
    reservedWindows: plan.reservedWindows,
    ...(plan.kind === 'regular'
      ? { sessionStartsAt: plan.sessionStartsAt, sessionEndsAt: plan.sessionEndsAt }
      : plan.kind === 'session'
        ? { boundaryAt: plan.boundaryAt }
        : { observedTtlSeconds: plan.observedTtlSeconds }),
  });
  const regular = plan.kind === 'regular';
  const binding = {
    plan,
    source: request.source,
    instrument: request.instrument,
    ...(regular ? { observationJobId: request.observationJobId } : {}),
  };
  if (
    request.id !== id ||
    contentHash(recalculated) !== contentHash(plan) ||
    (plan.kind === 'session' ? plan.observedTtlSeconds !== null : plan.boundaryAt !== null) ||
    (regular &&
      (plan.observedTtlSeconds !== null ||
        plan.samples !== 60 ||
        !plan.regularOnly ||
        !request.observationJobId?.startsWith(request.instrument.market.toLowerCase() + '-') ||
        request.observationJobId.slice(3, 13) !==
          marketTradingDate(Date.parse(plan.startsAt), request.instrument.market))) ||
    (!regular &&
      (request.observationJobId !== undefined ||
        plan.regularOnly ||
        plan.sessionStartsAt !== undefined ||
        plan.sessionEndsAt !== undefined)) ||
    (request.source === 'demo' &&
      contentHash(request.instrument) !== contentHash({ market: 'KR', symbol: '005930' })) ||
    contentHash(binding) !== request.planHash
  )
    throw new Error('INVALID_SUPERVISION_RECORD');
  const result = input.result === null ? null : resultSchema.parse(input.result);
  if (result) {
    const { hash: expected, ...body } = result;
    if (
      contentHash(body) !== expected ||
      result.id !== id ||
      result.source !== request.source ||
      result.planHash !== request.planHash ||
      result.buildHash !== request.buildHash ||
      (result.forced && (result.code !== 'SUPERVISOR_FORCED_STOP' || result.childCleanupConfirmed))
    )
      throw new Error('INVALID_SUPERVISION_RECORD');
    if (result.state === 'observation-completed') {
      if (
        result.stage !== 'verify' ||
        result.code !== null ||
        result.forced ||
        !result.childCleanupConfirmed ||
        !result.evidence ||
        result.evidence.samples !== plan.samples ||
        result.evidence.healthy + result.evidence.closed + result.evidence.blocked !== result.evidence.samples
      )
        throw new Error('INVALID_SUPERVISION_RECORD');
    } else if (result.code === null || result.evidence !== null) throw new Error('INVALID_SUPERVISION_RECORD');
  }
  const requested = Date.parse(request.requestedAt);
  const finished = result ? Date.parse(result.finishedAt) : null;
  const cutoff = Date.parse(plan.deadline) - plan.cleanupAllowanceMs;
  const clockUnverified =
    !Number.isFinite(now) ||
    requested > now ||
    (finished !== null && (finished > now || finished < requested)) ||
    requested >= cutoff ||
    Date.parse(plan.startsAt) - requested > 36 * 3600_000 ||
    requested - Date.parse(plan.startsAt) > 120_000 ||
    (result?.state === 'observation-completed' && (finished! < Date.parse(plan.startsAt) || finished! >= cutoff)) ||
    result?.code === 'SUPERVISOR_CLOCK_CHANGED';
  return {
    id,
    source: request.source,
    instrument: request.instrument,
    kind: plan.kind,
    state: result?.state ?? ('awaiting-result' as const),
    requestedAt: request.requestedAt,
    startsAt: plan.startsAt,
    deadline: plan.deadline,
    finishedAt: result?.finishedAt ?? null,
    deadlineElapsed: clockUnverified ? null : now >= Date.parse(plan.deadline),
    clockUnverified,
    plannedSamples: plan.samples,
    intervalSeconds: plan.intervalSeconds,
    planHash: request.planHash,
    buildHash: request.buildHash,
    resultHashVerified: result !== null,
    stage: result?.stage ?? null,
    code: result?.code ?? null,
    forced: result?.forced ?? null,
    childCleanupConfirmed: result?.childCleanupConfirmed ?? null,
    samples: result?.evidence?.samples ?? null,
    healthy: result?.evidence?.healthy ?? null,
    closed: result?.evidence?.closed ?? null,
    blocked: result?.evidence?.blocked ?? null,
    ...boundaries,
  };
}

/** Link only a newly recorded regular job to a clean owned result. No execution authority. */
export function verifyRegularSupervisionLink(
  id: string,
  input: { request: unknown; result: unknown },
  now: number,
  expectedJobId: string,
) {
  try {
    observationJobSchema.shape.id.parse(expectedJobId);
    const summary = summarizeReadonlySupervision(id, input, now),
      request = requestSchema.parse(input.request),
      result = resultSchema.parse(input.result);
    if (
      request.plan.kind !== 'regular' ||
      request.source !== 'market' ||
      request.observationJobId !== expectedJobId ||
      summary.clockUnverified ||
      result.state !== 'observation-completed' ||
      !result.childCleanupConfirmed ||
      result.forced ||
      !result.evidence ||
      result.evidence.samples !== 60 ||
      result.evidence.healthy !== 60 ||
      result.evidence.closed !== 0 ||
      result.evidence.blocked !== 0 ||
      !request.plan.sessionStartsAt ||
      !request.plan.sessionEndsAt
    )
      throw new Error('INVALID');
    const job = observationJobSchema.parse({
      id: expectedJobId,
      startsAt: request.plan.startsAt,
      launchedAt: request.requestedAt,
      instrument: request.instrument,
      requestedSamples: 60,
      intervalSeconds: request.plan.intervalSeconds,
      state: 'completed',
      failureCode: null,
      reportId: result.evidence.id,
      recordedSamples: 60,
      executionEnabled: false,
    });
    return {
      job,
      reportId: result.evidence.id,
      journalSha256: result.evidence.journalSha256,
      sessionStartsAt: request.plan.sessionStartsAt,
      sessionEndsAt: request.plan.sessionEndsAt,
      supervisorFinishedAt: result.finishedAt,
      supervisionHash: contentHash({ request, result }),
    };
  } catch {
    throw new Error('SUPERVISED_PREREQUISITE_INVALID');
  }
}

type Summary = ReturnType<typeof summarizeReadonlySupervision>;
const defaultRoot = fileURLToPath(new URL('../../../.local-data/readonly-supervisions', import.meta.url));
const maxFileBytes = 64 * 1024;
const maxScannedEntries = 256;
const maxRecords = 100;
const missing = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT';

async function directory(path: string) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(path)) !== path)
    throw new Error('INVALID_DIRECTORY');
  return info;
}

async function readFileBounded(path: string, optional = false): Promise<unknown> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (optional && missing(error)) return null;
    throw error;
  }
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > maxFileBytes) throw new Error('INVALID_FILE');
    const buffer = Buffer.alloc(maxFileBytes + 1);
    let total = 0;
    while (total <= maxFileBytes) {
      const { bytesRead } = await file.read(buffer, total, buffer.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > maxFileBytes) throw new Error('INVALID_FILE');
    }
    const after = await file.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || total !== before.size)
      throw new Error('CHANGED_FILE');
    const parsed: unknown = JSON.parse(buffer.subarray(0, total).toString('utf8'));
    if (parsed === null) throw new Error('INVALID_FILE');
    return parsed;
  } finally {
    await file.close();
  }
}

/** root is a trusted server/test composition input, never a CLI/browser parameter. */
export function createReadonlySupervisionStatus(root = defaultRoot, now: () => number = Date.now) {
  const fixedRoot = resolve(root);
  let previousTime = -Infinity;
  return {
    async list() {
      const runs: Summary[] = [];
      let scannedCount = 0;
      let rejectedCount = 0;
      let limited = false;
      const time = now();
      const clockUnverified = !Number.isFinite(time) || time < previousTime;
      if (Number.isFinite(time)) previousTime = Math.max(previousTime, time);
      const response = (availability: 'available' | 'not-recorded' | 'unavailable') => ({
        service: 'readonly-supervision-status' as const,
        availability,
        scannedCount,
        rejectedCount,
        limited,
        clockUnverified: clockUnverified || runs.some((run) => run.clockUnverified),
        runs: [...runs].sort((a, b) => a.id.localeCompare(b.id)),
        ...boundaries,
      });
      let rootInfo;
      try {
        // Checking ancestors also rejects a symlinked .local-data or workspace parent.
        const ancestors: string[] = [];
        for (let path = dirname(fixedRoot); ; path = dirname(path)) {
          ancestors.push(path);
          if (dirname(path) === path) break;
        }
        for (const ancestor of ancestors.reverse()) await directory(ancestor);
        rootInfo = await directory(fixedRoot);
      } catch (error) {
        return response(missing(error) ? 'not-recorded' : 'unavailable');
      }
      try {
        const stream = await opendir(fixedRoot);
        for await (const entry of stream) {
          if (scannedCount >= maxScannedEntries || runs.length + rejectedCount >= maxRecords) {
            limited = true;
            break;
          }
          scannedCount++;
          if (!z.uuid().safeParse(entry.name).success || !entry.isDirectory() || entry.isSymbolicLink()) {
            rejectedCount++;
            continue;
          }
          try {
            const path = join(fixedRoot, entry.name);
            const before = await directory(path);
            const request = await readFileBounded(join(path, 'request.json'));
            const result = await readFileBounded(join(path, 'result.json'), true);
            const run = summarizeReadonlySupervision(entry.name, { request, result }, time);
            const after = await directory(path);
            if (before.dev !== after.dev || before.ino !== after.ino) throw new Error('CHANGED_DIRECTORY');
            if (clockUnverified) {
              run.clockUnverified = true;
              run.deadlineElapsed = null;
            }
            runs.push(run);
          } catch {
            rejectedCount++;
          }
        }
        const after = await directory(fixedRoot);
        if (rootInfo.dev !== after.dev || rootInfo.ino !== after.ino) throw new Error('CHANGED_ROOT');
        return response('available');
      } catch {
        runs.length = 0;
        return response('unavailable');
      }
    },
  };
}
