import { z } from 'zod';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const instant = z.iso.datetime({ offset: true });
const safety = { executionEnabled: z.literal(false), canResume: z.literal(false) };
export const ownedPaperLaunchSchema = z.strictObject({
  formatVersion: z.literal('owned-paper-launch-v1'),
  id: z.uuid(),
  runId: z.uuid(),
  nonce: z.uuid(),
  runnerHash: hash,
  argumentsHash: hash,
  startedAt: instant,
  automaticRetry: z.literal(false),
  ...safety,
});
export const ownedPaperExitSchema = z.strictObject({
  formatVersion: z.literal('owned-paper-exit-v1'),
  launchId: z.uuid(),
  runId: z.uuid(),
  nonce: z.uuid(),
  launchHash: hash,
  exitCode: z.number().int().min(0).max(255).nullable(),
  signal: z.enum(['SIGTERM', 'SIGINT', 'SIGKILL']).nullable(),
  forced: z.boolean(),
  clockUnverified: z.boolean(),
  observedExitAt: instant,
  ...safety,
  hash,
});
export const orphanPaperSnapshotSchema = z.strictObject({
  runId: z.uuid(),
  files: z
    .array(z.strictObject({ name: z.literal('result.json'), bytes: z.number().int().min(1).max(16384), sha256: hash }))
    .length(1),
  missing: z.tuple([
    z.literal('request.json'),
    z.literal('before.json'),
    z.literal('after.json'),
    z.literal('review.json'),
  ]),
});
export const paperReservationClosureSchema = z.strictObject({
  formatVersion: z.literal('paper-reservation-closure-v1'),
  runId: z.uuid(),
  launchId: z.uuid(),
  snapshotHash: hash,
  launchHash: hash,
  exitHash: hash,
  terminalHash: hash,
  scope: z.literal('retire-reservation-only'),
  historicalOutcomeVerified: z.literal(false),
  createdAt: instant,
  ...safety,
  hash,
});
