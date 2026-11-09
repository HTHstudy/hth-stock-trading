import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { contentHash } from '@hth/database';
import { paperReviewArtifactSchema, paperReviewCheckpointSchema } from '@hth/contracts';
import { paperValidationRequestSchema, paperValidationResultSchema } from './paper-validation-record-schema.js';
import { ownedPaperLaunchSchema, ownedPaperExitSchema } from './paper-reservation-closure-contracts.js';
import { summarizePaperValidation } from './paper-validation-status.js';
import { reviewPaperCheckpoints } from './paper-review.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const identity = z.strictObject({
  parentRunId: z.uuid(),
  parentLaunchId: z.uuid(),
  market: z.enum(['KR', 'US']),
  asOf: z.iso.datetime({ offset: true }),
});
const bundleSchema = z.strictObject({
  request: paperValidationRequestSchema,
  result: paperValidationResultSchema,
  before: paperReviewCheckpointSchema,
  after: paperReviewCheckpointSchema,
  review: paperReviewArtifactSchema,
  launch: ownedPaperLaunchSchema,
  exit: ownedPaperExitSchema,
});
const fail = () => new Error('PAPER_CONTINUATION_INVALID');
function microtime(value: string) {
  const fraction = value.match(/\.(\d+)/)?.[1] ?? '';
  if (fraction.length > 6) throw fail();
  return BigInt(Date.parse(value)) * 1000n + BigInt(fraction.padEnd(6, '0').slice(3));
}
const clean = (s: z.infer<typeof paperReviewCheckpointSchema>['snapshot']) =>
  s.stopped &&
  !s.leasePresent &&
  !s.reservations.some((r) => r.active) &&
  !s.intents.some((i) => ['INTENT_RECORDED', 'READY', 'PARTIALLY_FILLED'].includes(i.state));

export function verifyPaperContinuationBundle(input: unknown, contextInput: unknown) {
  try {
    const context = identity.parse(contextInput),
      bundle = bundleSchema.parse(input);
    const { request, result, before, after, review, launch, exit } = bundle;
    const status = summarizePaperValidation(context.parentRunId, bundle, Date.parse(context.asOf));
    const { hash: exitHash, ...exitPayload } = exit;
    const recomputed = reviewPaperCheckpoints(before, after, review.report.asOf);
    const expectedExit = result.state === 'completed' ? 0 : 2;
    const optionalPaths = new Set(['intentPath', 'fillPath', 'diagnosticsRecorded', 'workerCycle']);
    if (
      request.market !== context.market ||
      !request.resourcesHash ||
      !['completed', 'completed-with-incomplete-review', 'execution-ended-early'].includes(result.state) ||
      (result.state === 'execution-ended-early' &&
        !['PAPER_VALIDATION_PAUSED', 'PAPER_VALIDATION_WAITING'].includes(result.code ?? '')) ||
      result.stoppedAndCleaned !== true ||
      (result.state !== 'execution-ended-early' &&
        (result.completedTicks !== 60 || result.runningTicks !== 60 || result.code !== undefined)) ||
      (result.state === 'execution-ended-early' &&
        (result.completedTicks < 1 ||
          result.runningTicks === undefined ||
          result.runningTicks >= result.completedTicks)) ||
      status.clock !== 'not-in-future' ||
      status.evidence !== 'linked-review' ||
      review.report.verdict === 'issues-found' ||
      contentHash(recomputed) !== review.hash ||
      Object.entries(recomputed.checks).some(([name, value]) => value !== 'passed' && !optionalPaths.has(name)) ||
      recomputed.evidence?.leaseAcquisitions !== 1 ||
      recomputed.evidence.leaseReleases !== 1 ||
      !clean(after.snapshot) ||
      launch.id !== context.parentLaunchId ||
      launch.runId !== context.parentRunId ||
      exit.launchId !== launch.id ||
      exit.runId !== launch.runId ||
      exit.nonce !== launch.nonce ||
      exit.launchHash !== contentHash(launch) ||
      exitHash !== contentHash(exitPayload) ||
      exit.exitCode !== expectedExit ||
      exit.signal !== null ||
      exit.forced ||
      exit.clockUnverified ||
      microtime(launch.startedAt) > microtime(before.snapshot.asOf) ||
      microtime(exit.observedExitAt) < microtime(result.finishedAt) ||
      microtime(exit.observedExitAt) > microtime(context.asOf)
    )
      throw fail();
    return {
      parentRunId: context.parentRunId,
      parentLaunchId: context.parentLaunchId,
      market: context.market,
      resourcesHash: request.resourcesHash,
      baseline: after,
      canonicalHash: contentHash(bundle),
      executionEnabled: false as const,
      canResume: false as const,
    };
  } catch {
    throw fail();
  }
}

// Equality excludes only read time. Cash, PnL dates/losses, all history and CAS controls are pinned.
export function verifyPaperContinuationBaseline(parentInput: unknown, currentInput: unknown) {
  try {
    const parent = paperReviewCheckpointSchema.parse(parentInput),
      current = paperReviewCheckpointSchema.parse(currentInput);
    const { asOf: parentTime, ...a } = parent.snapshot,
      { asOf: currentTime, ...b } = current.snapshot;
    const report = reviewPaperCheckpoints(parent, current, currentTime);
    if (
      parent.snapshot.source !== 'toss-readonly' ||
      !clean(parent.snapshot) ||
      !clean(current.snapshot) ||
      Date.parse(currentTime) < Date.parse(parentTime) ||
      contentHash(a) !== contentHash(b) ||
      report.checks.beforeIntegrity !== 'passed' ||
      report.checks.afterIntegrity !== 'passed' ||
      report.verdict === 'issues-found'
    )
      throw fail();
    return {
      baselineHash: parent.hash,
      checkedHash: current.hash,
      unchanged: true as const,
      executionEnabled: false as const,
      canResume: false as const,
    };
  } catch {
    throw fail();
  }
}

// Only this runner's known preparation events may extend the pinned parent history.
export function verifyPaperContinuationEvents(
  beforeInput: unknown,
  afterInput: unknown,
  phase: 'unchanged' | 'daily-review' | 'stopped-observation' | 'before-resume',
) {
  try {
    const before = paperReviewCheckpointSchema.parse(beforeInput),
      after = paperReviewCheckpointSchema.parse(afterInput);
    if (
      contentHash(before.snapshot) !== before.hash ||
      contentHash(after.snapshot) !== after.hash ||
      before.snapshot.scope !== after.snapshot.scope
    )
      throw fail();
    const previous = new Map(before.snapshot.events.map((event) => [event.key, event]));
    const current = new Map(after.snapshot.events.map((event) => [event.key, event]));
    if (
      previous.size !== before.snapshot.events.length ||
      current.size !== after.snapshot.events.length ||
      [...previous].some(([key, event]) => contentHash(current.get(key) ?? null) !== contentHash(event))
    )
      throw fail();
    const expected = {
      unchanged: [],
      'daily-review': ['LEASE_ACQUIRED', 'DAILY_REVIEW_COMPLETED', 'LEASE_RELEASED'],
      'stopped-observation': [
        'LEASE_ACQUIRED',
        'WORKER_RECOVERED',
        'ACCOUNT_OBSERVED',
        'ACCOUNT_OBSERVED',
        'LEASE_RELEASED',
        'STRATEGY_DIAGNOSED',
      ],
      'before-resume': ['LEASE_ACQUIRED', 'WORKER_RECOVERED', 'ACCOUNT_OBSERVED'],
    }[phase];
    const added = after.snapshot.events.filter((event) => !previous.has(event.key));
    if (contentHash(added.map((event) => event.kind).sort()) !== contentHash([...expected].sort())) throw fail();
    return contentHash(after.snapshot.events);
  } catch {
    throw fail();
  }
}

// Fixed UUID roots only. No credentials, account IDs or caller-selected filenames are read/returned.
export async function readPaperContinuation(rootInput: string, contextInput: unknown, expectedHash?: string) {
  try {
    const context = identity.parse(contextInput);
    if (expectedHash !== undefined) hash.parse(expectedHash);
    const root = resolve(rootInput),
      canonical = await realpath(root);
    const files: Record<string, unknown> = {},
      digests: Record<string, string> = {};
    const directories = new Map<string, { dev: number; ino: number }>();
    let budget = 64 * 1048576;
    for (const [kind, id, names] of [
      ['paper-validation-runs', context.parentRunId, ['request', 'result', 'before', 'after', 'review']],
      ['paper-validation-processes', context.parentLaunchId, ['launch', 'exit']],
    ] as const) {
      const parent = join(root, '.local-data', kind),
        directory = join(parent, id);
      for (const path of [join(root, '.local-data'), parent, directory]) {
        const info = await lstat(path);
        if (
          !info.isDirectory() ||
          info.isSymbolicLink() ||
          (await realpath(path)) !== join(canonical, path.slice(root.length + 1))
        )
          throw fail();
        directories.set(path, { dev: info.dev, ino: info.ino });
      }
      for (const name of names) {
        const path = join(directory, name + '.json'),
          handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const before = await handle.stat(),
            limit = Math.min(['before', 'after', 'review'].includes(name) ? 32 * 1048576 : 65536, budget);
          if (!before.isFile() || before.size > limit) throw fail();
          const chunks: Buffer[] = [];
          let bytes = 0;
          for await (const chunk of handle.createReadStream({ autoClose: false, start: 0, end: limit })) {
            const part = chunk as Buffer;
            bytes += part.length;
            if (bytes > limit) throw fail();
            chunks.push(part);
          }
          budget -= bytes;
          const after = await handle.stat(),
            current = await lstat(path);
          if (
            bytes !== before.size ||
            after.size !== before.size ||
            after.mtimeMs !== before.mtimeMs ||
            after.ctimeMs !== before.ctimeMs ||
            !current.isFile() ||
            current.isSymbolicLink() ||
            current.ino !== before.ino ||
            current.dev !== before.dev
          )
            throw fail();
          const data = Buffer.concat(chunks);
          files[name] = JSON.parse(data.toString('utf8'));
          digests[name] = createHash('sha256').update(data).digest('hex');
        } finally {
          await handle.close();
        }
      }
      if ((await realpath(directory)) !== join(canonical, '.local-data', kind, id)) throw fail();
    }
    for (const [path, identity] of directories) {
      const current = await lstat(path);
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        current.dev !== identity.dev ||
        current.ino !== identity.ino ||
        (await realpath(path)) !== join(canonical, path.slice(root.length + 1))
      )
        throw fail();
    }
    const verified = verifyPaperContinuationBundle(files, context);
    const evidenceHash = contentHash({ canonicalHash: verified.canonicalHash, files: digests });
    if (expectedHash !== undefined && expectedHash !== evidenceHash) throw fail();
    return { ...verified, evidenceHash };
  } catch {
    throw fail();
  }
}
