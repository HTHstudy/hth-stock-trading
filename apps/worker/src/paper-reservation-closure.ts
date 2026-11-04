import { contentHash } from '@hth/database';
import { paperValidationResultSchema } from './paper-validation-record-schema.js';
import {
  orphanPaperSnapshotSchema,
  ownedPaperLaunchSchema,
  ownedPaperExitSchema,
  paperReservationClosureSchema,
} from './paper-reservation-closure-contracts.js';

function evidenceTime(value: string) {
  const fraction = value.match(/\.(\d+)/)?.[1] ?? '';
  if (fraction.length > 6) throw new Error('PAPER_CLOSURE_EVIDENCE_INVALID');
  return BigInt(Date.parse(value)) * 1000n + BigInt(fraction.padEnd(6, '0').slice(3));
}

export function planPaperReservationClosure(
  input: {
    snapshot: unknown;
    terminal: unknown;
    launch: unknown;
    exit: unknown;
  },
  now: number,
) {
  const snapshot = orphanPaperSnapshotSchema.parse(input.snapshot);
  const terminal = paperValidationResultSchema.parse(input.terminal);
  const launch = ownedPaperLaunchSchema.parse(input.launch);
  const exit = ownedPaperExitSchema.parse(input.exit);
  const { hash: exitHash, ...exitBody } = exit;
  const launchAt = evidenceTime(launch.startedAt),
    finished = evidenceTime(terminal.finishedAt),
    closed = evidenceTime(exit.observedExitAt);
  if (
    !Number.isSafeInteger(now) ||
    contentHash(exitBody) !== exitHash ||
    exit.launchHash !== contentHash(launch) ||
    launch.runId !== snapshot.runId ||
    exit.runId !== snapshot.runId ||
    exit.launchId !== launch.id ||
    exit.nonce !== launch.nonce ||
    exit.forced ||
    exit.signal !== null ||
    exit.exitCode !== 1 ||
    exit.clockUnverified ||
    launchAt > finished ||
    finished > closed ||
    closed > BigInt(now) * 1000n ||
    terminal.state !== 'stopped-before-run-or-failed' ||
    terminal.phase !== 'waiting' ||
    terminal.runStarted !== false ||
    terminal.completedTicks !== 0 ||
    (terminal.runningTicks !== undefined && terminal.runningTicks !== 0) ||
    terminal.code !== 'PAPER_BUILD_CHANGED' ||
    (terminal.stoppedAndCleaned !== undefined && terminal.stoppedAndCleaned !== true) ||
    terminal.verdict !== undefined ||
    (terminal.intents !== undefined && terminal.intents !== 0) ||
    (terminal.fills !== undefined && terminal.fills !== 0)
  )
    throw new Error('PAPER_CLOSURE_EVIDENCE_INVALID');
  const body = {
    formatVersion: 'paper-reservation-closure-plan-v1' as const,
    runId: snapshot.runId,
    launchId: launch.id,
    snapshotHash: contentHash(snapshot),
    launchHash: contentHash(launch),
    exitHash: contentHash(exit),
    terminalHash: contentHash(terminal),
    scope: 'retire-reservation-only' as const,
    historicalOutcomeVerified: false as const,
    executionEnabled: false as const,
    canResume: false as const,
  };
  return { ...body, hash: contentHash(body) };
}

export function verifyPaperReservationClosure(
  closureInput: unknown,
  input: Parameters<typeof planPaperReservationClosure>[0],
  now: number,
) {
  const closure = paperReservationClosureSchema.parse(closureInput);
  const { hash, ...body } = closure;
  if (!Number.isSafeInteger(now) || contentHash(body) !== hash || evidenceTime(closure.createdAt) > BigInt(now) * 1000n)
    throw new Error('PAPER_CLOSURE_EVIDENCE_INVALID');
  const plan = planPaperReservationClosure(input, now);
  const exit = ownedPaperExitSchema.parse(input.exit);
  if (
    evidenceTime(closure.createdAt) < evidenceTime(exit.observedExitAt) ||
    (['runId', 'launchId', 'snapshotHash', 'launchHash', 'exitHash', 'terminalHash'] as const).some(
      (key) => closure[key] !== plan[key],
    )
  )
    throw new Error('PAPER_CLOSURE_EVIDENCE_INVALID');
  return {
    reservationRetired: true as const,
    historicalOutcomeVerified: false as const,
    executionEnabled: false as const,
    canResume: false as const,
  };
}
