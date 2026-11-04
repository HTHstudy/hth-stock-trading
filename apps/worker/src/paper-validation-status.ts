import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import {
  paperReviewArtifactSchema,
  paperReviewCheckpointSchema,
  paperValidationCheckNames,
  paperValidationRunSchema,
  paperValidationStatusSchema,
} from '@hth/contracts';
import { contentHash } from '@hth/database';

import { createPaperReservationClosures } from './paper-reservation-closure-store.js';

import { summarizeRunDiagnostics, unavailableRunDiagnostics } from './paper-run-diagnostics.js';

import {
  paperValidationRequestSchema as requestSchema,
  paperValidationResultSchema as resultSchema,
} from './paper-validation-record-schema.js';

const visibleChecks = new Set<string>(paperValidationCheckNames);

function checkpoint(input: unknown) {
  if (input === null) return null;
  const value = paperReviewCheckpointSchema.parse(input);
  if (contentHash(value.snapshot) !== value.hash || value.snapshot.source !== 'toss-readonly')
    throw new Error('INVALID_EVIDENCE');
  return value;
}

type PaperValidationEvidenceInput = {
  request: unknown;
  result: unknown;
  before: unknown;
  after: unknown;
  review: unknown;
  diagnostics?: unknown;
};

/** Classification only: never grants an exception to reservation checks. */
export function auditPaperValidationRecord(id: string, input: PaperValidationEvidenceInput, now: number) {
  const report = (
    classification:
      | 'invalid-id'
      | 'request-missing-or-null'
      | 'request-invalid'
      | 'result-invalid'
      | 'before-invalid'
      | 'after-invalid'
      | 'review-invalid'
      | 'linked-evidence-invalid'
      | 'status-readable',
  ) => ({
    formatVersion: 'paper-reservation-audit-v1' as const,
    classification,
    statusReadable: classification === 'status-readable',
    canIgnoreReservation: false as const,
    processLivenessChecked: false as const,
    ledgerReviewRecomputed: false as const,
    executionEnabled: false as const,
    canResume: false as const,
  });
  if (!z.uuid().safeParse(id).success) return report('invalid-id');
  // The filesystem status reader maps ENOENT to null. An in-memory null cannot
  // distinguish a missing file from a JSON null; do not invent that evidence.
  if (input.request === null || input.request === undefined) return report('request-missing-or-null');
  if (!requestSchema.safeParse(input.request).success) return report('request-invalid');
  if (input.result !== null && !resultSchema.safeParse(input.result).success) return report('result-invalid');
  for (const name of ['before', 'after'] as const) {
    try {
      checkpoint(input[name]);
    } catch {
      return report(name === 'before' ? 'before-invalid' : 'after-invalid');
    }
  }
  if (input.review !== null && !paperReviewArtifactSchema.safeParse(input.review).success)
    return report('review-invalid');
  try {
    summarizePaperValidation(id, input, now);
    return report('status-readable');
  } catch {
    // Includes cross-file linkage, checksum and semantic checks. Never return
    // Zod paths/messages or the original error, which may contain private data.
    return report('linked-evidence-invalid');
  }
}

export function summarizePaperValidation(id: string, input: PaperValidationEvidenceInput, now: number) {
  z.uuid().parse(id);
  const request = requestSchema.parse(input.request);
  const result = input.result === null ? null : resultSchema.parse(input.result);
  if (result && result.market !== request.market) throw new Error('INVALID_EVIDENCE');
  const before = checkpoint(input.before),
    after = checkpoint(input.after);
  const review = input.review === null ? null : paperReviewArtifactSchema.parse(input.review);
  if (review) {
    if (
      !before ||
      !after ||
      contentHash(review.report) !== review.hash ||
      review.report.source !== 'toss-readonly' ||
      review.report.beforeHash !== before.hash ||
      review.report.afterHash !== after.hash ||
      review.report.scope !== before.snapshot.scope ||
      review.report.scope !== after.snapshot.scope ||
      (result?.verdict !== undefined && result.verdict !== review.report.verdict)
    )
      throw new Error('INVALID_EVIDENCE');
  }
  if (
    result &&
    ['completed', 'completed-with-incomplete-review', 'review-issues-found', 'execution-ended-early'].includes(
      result.state,
    ) &&
    !review
  )
    throw new Error('INVALID_EVIDENCE');
  if (
    result?.state === 'completed' &&
    (result.completedTicks !== 60 ||
      result.runningTicks !== 60 ||
      result.verdict !== 'consistent-observed-state' ||
      !result.stoppedAndCleaned)
  )
    throw new Error('INVALID_EVIDENCE');
  if (result?.state === 'completed-with-incomplete-review' && result.verdict !== 'incomplete')
    throw new Error('INVALID_EVIDENCE');
  if (result?.state === 'review-issues-found' && result.verdict !== 'issues-found') throw new Error('INVALID_EVIDENCE');
  if (result && after) {
    const snapshot = after.snapshot;
    const cleaned =
      snapshot.stopped &&
      !snapshot.leasePresent &&
      !snapshot.reservations.some((item) => item.active) &&
      !snapshot.intents.some((item) => ['INTENT_RECORDED', 'READY', 'PARTIALLY_FILLED'].includes(item.state));
    if (
      (result.intents !== undefined && result.intents !== snapshot.intents.length) ||
      (result.fills !== undefined && result.fills !== snapshot.fills.length) ||
      (result.stoppedAndCleaned !== undefined && result.stoppedAndCleaned !== cleaned)
    )
      throw new Error('INVALID_EVIDENCE');
  }
  const microtime = (time: string) =>
    BigInt(Date.parse(time)) * 1000n + BigInt((time.match(/\.(\d+)/)?.[1] ?? '').padEnd(6, '0').slice(3, 6));
  const times = [before?.snapshot.asOf, after?.snapshot.asOf, review?.report.asOf, result?.finishedAt]
    .filter((time): time is string => time !== undefined)
    .map(microtime);
  const clockUnverified =
    times.some((time) => time > BigInt(now + 1000) * 1000n) ||
    times.some((time, index) => index > 0 && time < times[index - 1]!);
  let diagnostics = null;
  if (input.diagnostics !== undefined && input.diagnostics !== null) {
    try {
      if (!before || !after) throw new Error('INVALID_DIAGNOSTICS');
      diagnostics = summarizeRunDiagnostics(input.diagnostics, before, after);
    } catch {
      diagnostics = unavailableRunDiagnostics();
    }
  }
  return paperValidationRunSchema.parse({
    id,
    market: request.market,
    startsAt: request.startsAt,
    deadline: request.deadline,
    state: result ? 'terminal-recorded' : 'awaiting-result',
    resultState: result?.state ?? null,
    deadlineElapsed: now >= Date.parse(request.deadline),
    clock: clockUnverified ? 'unverified' : 'not-in-future',
    finishedAt: result?.finishedAt ?? null,
    code: result?.code ?? null,
    completedTicks: result?.completedTicks ?? null,
    runningTicks: result?.runningTicks ?? null,
    evidence: review ? 'linked-review' : after ? 'after-checkpoint' : before ? 'before-checkpoint' : 'request-only',
    verdict: review?.report.verdict ?? null,
    checks: review
      ? Object.fromEntries(Object.entries(review.report.checks).filter(([key]) => visibleChecks.has(key)))
      : null,
    observedCounts: review?.report.evidence ?? null,
    stoppedAndCleaned: result?.stoppedAndCleaned ?? null,
    diagnostics,
    executionEnabled: false,
    canResume: false,
    processLivenessChecked: false,
    ledgerReviewRecomputed: false,
  });
}

export function createPaperValidationStatus(directory: string, now: () => number = Date.now) {
  const root = resolve(directory);
  async function scan(onRejected?: (id: string) => Promise<void>) {
    const asOf = now();
    const runs: ReturnType<typeof summarizePaperValidation>[] = [];
    let rejectedCount = 0,
      scanned = 0,
      bytes = 0,
      limited = false;
    try {
      const info = await lstat(root);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('INVALID_ROOT');
      const canonical = await realpath(root);
      const read = async (folder: string, name: string, limit: number): Promise<unknown> => {
        let file;
        try {
          file = await open(join(folder, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
          throw error;
        }
        try {
          const stat = await file.stat();
          if (!stat.isFile() || stat.size > limit) throw new Error('INVALID_EVIDENCE');
          if (bytes + stat.size > 64 * 1048576) {
            limited = true;
            throw new Error('SCAN_LIMIT');
          }
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const part of file.createReadStream({ autoClose: false, start: 0, end: limit })) {
            const chunk = part as Buffer;
            size += chunk.length;
            bytes += chunk.length;
            if (bytes > 64 * 1048576) limited = true;
            if (size > limit || limited) throw new Error('INVALID_EVIDENCE');
            chunks.push(chunk);
          }
          return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
        } finally {
          await file.close();
        }
      };
      for await (const entry of await opendir(root)) {
        if (++scanned > 100 || runs.length >= 50 || limited) {
          limited = true;
          break;
        }
        if (!z.uuid().safeParse(entry.name).success) continue;
        try {
          const folder = join(root, entry.name);
          if (
            !entry.isDirectory() ||
            entry.isSymbolicLink() ||
            (await realpath(folder)) !== join(canonical, entry.name)
          )
            throw new Error('INVALID_EVIDENCE');
          const request = await read(folder, 'request.json', 16384);
          const result = await read(folder, 'result.json', 16384);
          const before = await read(folder, 'before.json', 32 * 1048576);
          const after = await read(folder, 'after.json', 32 * 1048576);
          const review = await read(folder, 'review.json', 1048576);
          const diagnostics = await read(folder, 'diagnostics.json', 8 * 1048576).catch(() => ({ invalid: true }));
          if ((await realpath(folder)) !== join(canonical, entry.name) || (await realpath(root)) !== canonical)
            throw new Error('INVALID_EVIDENCE');
          runs.push(
            summarizePaperValidation(entry.name, { request, result, before, after, review, diagnostics }, asOf),
          );
        } catch {
          rejectedCount++;
          if (onRejected) {
            try {
              await onRejected(entry.name);
            } catch {
              /* Unresolved records stay blocking. */
            }
          }
        }
      }
      return paperValidationStatusSchema.parse({
        service: 'paper-validation-status',
        asOf: new Date(asOf).toISOString(),
        availability: 'available',
        runs,
        rejectedCount,
        limited,
        executionEnabled: false,
        canResume: false,
      });
    } catch (error) {
      const missing = error instanceof Error && 'code' in error && error.code === 'ENOENT';
      return paperValidationStatusSchema.parse({
        service: 'paper-validation-status',
        asOf: new Date(asOf).toISOString(),
        availability: missing ? 'not-recorded' : 'unavailable',
        runs: [],
        rejectedCount,
        limited,
        executionEnabled: false,
        canResume: false,
      });
    }
  }
  return {
    list: () => scan(),
    async checkReservations() {
      const closures = createPaperReservationClosures(dirname(dirname(root)), now);
      const before = await closures.audit(),
        rejectedIds: string[] = [];
      const status = await scan(async (id) => {
        rejectedIds.push(id);
      });
      const after = await closures.audit();
      const stable = contentHash(before) === contentHash(after);
      const valid = new Set(stable ? after.verified.map((item) => item.runId) : []);
      const retiredCount = rejectedIds.filter((id) => valid.has(id)).length;
      const unresolved = new Set([...rejectedIds.filter((id) => !valid.has(id)), ...after.invalidIds]);
      return {
        ...status,
        availability: !stable || after.availability === 'unavailable' ? ('unavailable' as const) : status.availability,
        limited: status.limited || before.limited || after.limited,
        retiredCount,
        unresolvedCount: unresolved.size + after.unknownCount,
      };
    },
  };
}

// HTTP consumers receive only the historical, read-only list contract.
export type PaperValidationStatusReader = Pick<ReturnType<typeof createPaperValidationStatus>, 'list'>;
