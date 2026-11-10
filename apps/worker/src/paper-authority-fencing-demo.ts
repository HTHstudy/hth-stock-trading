import { contentHash } from '@hth/database';
import { paperAuthorityFencingSimulationSchema } from './paper-authority-fencing-simulation-contracts.js';

export const paperAuthorityFencingDemoCases = [
  'complete',
  'missing-broker',
  'existing-session',
  'changed-file',
  'cas-conflict',
] as const;
export function createPaperAuthorityFencingDemo(
  caseName: (typeof paperAuthorityFencingDemoCases)[number] = 'complete',
) {
  const hash = (name: string) => contentHash('synthetic-only:' + name);
  const at = (seconds: number) => new Date(Date.parse('2026-11-10T00:00:00.000Z') + seconds * 1000).toISOString();
  const plan = {
    authorityScopeHash: hash('scope'),
    legacyGeneration: 4,
    nextGeneration: 5,
    accountVersion: 8,
    accountEpoch: 3,
    policyRevisionHash: hash('policy'),
    baselineHash: hash('pending-baseline'),
  };
  const before = {
    capturedAt: at(2),
    authorityScopeHash: plan.authorityScopeHash,
    generation: 4,
    accountVersion: 8,
    accountEpoch: 3,
    businessLedgerHash: hash('ledger'),
    settingsHash: hash('settings'),
    originalRuns: [
      {
        runId: '10000000-0000-4000-8000-000000000001',
        files: [{ name: 'result.json', bytes: 1, sha256: hash('fake-file-bytes') }],
        missing: ['request.json', 'before.json', 'after.json', 'review.json'].sort(),
      },
    ],
    historicalRejectedCount: 1,
    historicalUnresolvedCount: 1,
    historicalRetiredCount: 0,
    stopped: true,
    leasePresent: false,
    openIntents: 0,
    activeReservations: 0,
  };
  plan.baselineHash = contentHash(Object.fromEntries(Object.entries(before).filter(([key]) => key !== 'capturedAt')));
  const evidence = {
    source: 'synthetic-fixture',
    origin: 'simulated-independent-controller',
    authorityScopeHash: plan.authorityScopeHash,
    legacyGeneration: 4,
    policyRevisionHash: plan.policyRevisionHash,
    planHash: contentHash(plan),
    collectorHash: hash('fixture-collector'),
    effectiveFrom: at(3),
    capturedAt: at(4),
    validUntil: at(60),
  };
  const value = paperAuthorityFencingSimulationSchema.parse({
    formatVersion: 'paper-authority-fencing-simulation-input-v1',
    source: 'synthetic-fixture',
    mode: 'paper',
    asOf: at(6),
    scopeComplete: 'simulated-confirmed',
    plan,
    before,
    after: { ...structuredClone(before), capturedAt: at(5) },
    approvals: ['policy', 'maintenance'].map((kind, index) => ({
      source: 'synthetic-fixture',
      kind,
      planHash: contentHash(plan),
      authorityScopeHash: plan.authorityScopeHash,
      legacyGeneration: 4,
      nextGeneration: 5,
      policyRevisionHash: plan.policyRevisionHash,
      issuedAt: at(index),
      expiresAt: at(60),
    })),
    evidence: [
      {
        ...evidence,
        domain: 'runtime',
        proofRef: 'fixture:runtime',
        checks: {
          launchDenied: 'simulated-confirmed',
          autostartDenied: 'simulated-confirmed',
          newSecretAccessDenied: 'simulated-confirmed',
        },
      },
      {
        ...evidence,
        domain: 'database',
        proofRef: 'fixture:database',
        checks: {
          newConnectionsDenied: 'simulated-confirmed',
          existingSessionsGone: 'simulated-confirmed',
          transactionsSettled: 'simulated-confirmed',
          alternateAccessDenied: 'simulated-confirmed',
        },
      },
      {
        ...evidence,
        domain: 'broker',
        proofRef: 'fixture:broker',
        checks: {
          newTokenIssuanceDenied: 'simulated-confirmed',
          existingTokensDenied: 'simulated-confirmed',
          existingConnectionsDenied: 'simulated-confirmed',
          providerScopeKnown: 'simulated-confirmed',
        },
      },
    ],
  });
  switch (caseName) {
    case 'complete':
      break;
    case 'missing-broker':
      value.evidence = value.evidence.filter((e) => e.domain !== 'broker');
      break;
    case 'existing-session': {
      const db = value.evidence.find((e) => e.domain === 'database')!;
      db.checks.existingSessionsGone = 'simulated-failed';
      break;
    }
    case 'changed-file':
      value.after.originalRuns[0]!.files[0]!.sha256 = hash('changed');
      break;
    case 'cas-conflict':
      value.after.accountVersion++;
      break;
    default:
      throw new Error('PAPER_AUTHORITY_SIMULATION_INVALID');
  }
  return value;
}
