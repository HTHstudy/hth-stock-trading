import { z } from 'zod';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const instant = z.iso.datetime({ offset: true, precision: 3 });
const count = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER - 2);
const check = z.enum(['simulated-confirmed', 'simulated-failed', 'missing', 'unverified']);
const fileName = z.string().regex(/^[a-z][a-z0-9-]{0,63}\.(json|jsonl)$/);
const requiredFile = z.enum(['request.json', 'result.json', 'before.json', 'after.json', 'review.json']);
const run = z.strictObject({
  runId: z.uuid().regex(/^[a-f0-9-]+$/),
  files: z
    .array(
      z.strictObject({
        name: fileName,
        bytes: z
          .number()
          .int()
          .min(1)
          .max(32 * 1048576),
        sha256: hash,
      }),
    )
    .max(16),
  missing: z.array(requiredFile).max(5),
});
const snapshot = z.strictObject({
  capturedAt: instant,
  authorityScopeHash: hash,
  generation: count,
  accountVersion: count,
  accountEpoch: count,
  businessLedgerHash: hash,
  settingsHash: hash,
  originalRuns: z.array(run).min(1).max(100),
  historicalRejectedCount: count,
  historicalUnresolvedCount: count,
  historicalRetiredCount: count,
  stopped: z.boolean(),
  leasePresent: z.boolean(),
  openIntents: count,
  activeReservations: count,
});
const evidence = {
  source: z.literal('synthetic-fixture'),
  origin: z.literal('simulated-independent-controller'),
  authorityScopeHash: hash,
  legacyGeneration: count,
  policyRevisionHash: hash,
  planHash: hash,
  collectorHash: hash,
  proofRef: z.string().regex(/^fixture:[a-z0-9-]{1,64}$/),
  effectiveFrom: instant,
  capturedAt: instant,
  validUntil: instant,
};
export const paperAuthorityFencingSimulationSchema = z.strictObject({
  formatVersion: z.literal('paper-authority-fencing-simulation-input-v1'),
  source: z.literal('synthetic-fixture'),
  mode: z.literal('paper'),
  asOf: instant,
  scopeComplete: check,
  plan: z.strictObject({
    authorityScopeHash: hash,
    legacyGeneration: count,
    nextGeneration: count,
    accountVersion: count,
    accountEpoch: count,
    policyRevisionHash: hash,
    baselineHash: hash,
  }),
  before: snapshot,
  after: snapshot,
  approvals: z
    .array(
      z.strictObject({
        source: z.literal('synthetic-fixture'),
        kind: z.enum(['policy', 'maintenance']),
        planHash: hash,
        authorityScopeHash: hash,
        legacyGeneration: count,
        nextGeneration: count,
        policyRevisionHash: hash,
        issuedAt: instant,
        expiresAt: instant,
      }),
    )
    .max(2),
  evidence: z
    .array(
      z.discriminatedUnion('domain', [
        z.strictObject({
          ...evidence,
          domain: z.literal('runtime'),
          checks: z.strictObject({ launchDenied: check, autostartDenied: check, newSecretAccessDenied: check }),
        }),
        z.strictObject({
          ...evidence,
          domain: z.literal('database'),
          checks: z.strictObject({
            newConnectionsDenied: check,
            existingSessionsGone: check,
            transactionsSettled: check,
            alternateAccessDenied: check,
          }),
        }),
        z.strictObject({
          ...evidence,
          domain: z.literal('broker'),
          checks: z.strictObject({
            newTokenIssuanceDenied: check,
            existingTokensDenied: check,
            existingConnectionsDenied: check,
            providerScopeKnown: check,
          }),
        }),
      ]),
    )
    .max(3),
});
export type PaperAuthorityFencingSimulationInput = z.infer<typeof paperAuthorityFencingSimulationSchema>;
