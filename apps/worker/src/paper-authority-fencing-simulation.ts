import { contentHash } from '@hth/database';
import { paperAuthorityFencingSimulationSchema } from './paper-authority-fencing-simulation-contracts.js';
import type { PaperAuthorityFencingSimulationInput } from './paper-authority-fencing-simulation-contracts.js';

const safety = {
  syntheticOnly: true,
  actualAuthorityVerified: false,
  currentAuthorityVerified: false,
  externalEvidenceAuthenticated: false,
  historicalOutcomeVerified: false,
  policyApplied: false,
  credentialsChanged: false,
  processesControlled: false,
  dbAccessed: false,
  originalFilesRead: false,
  historyMutationPerformed: false,
  documentApproval: false,
  operatingApproval: false,
  reservationExceptionsCreated: false,
  canIgnoreReservation: false,
  scheduled: false,
  resumeRequested: false,
  executionEnabled: false,
  canResume: false,
  automaticRetry: false,
} as const;
type Reason =
  | 'INPUT_INVALID'
  | 'SCOPE_UNVERIFIED'
  | 'SCOPE_MISMATCH'
  | 'CONTROL_CONFLICT'
  | 'BASELINE_MISMATCH'
  | 'ORIGINAL_SET_INVALID'
  | 'ORIGINAL_EVIDENCE_CHANGED'
  | 'LEDGER_CHANGED'
  | 'SETTINGS_CHANGED'
  | 'HISTORY_CHANGED'
  | 'ACCOUNT_NOT_CLEAN'
  | 'APPROVALS_MISSING'
  | 'APPROVAL_BINDING_INVALID'
  | 'EVIDENCE_MISSING'
  | 'EVIDENCE_BINDING_INVALID'
  | 'FENCE_UNVERIFIED'
  | 'TIME_INVALID';

// Fabricated-fact consistency only: no collectors, side effects or operating execution hooks.
export function evaluatePaperAuthorityFencingSimulation(input: unknown) {
  const parsed = paperAuthorityFencingSimulationSchema.safeParse(input);
  const finish = (reasons: Reason[], inputHash: string | null, simulatedAsOf: string | null) => ({
    formatVersion: 'paper-authority-fencing-simulation-result-v1' as const,
    state: reasons.length ? ('blocked' as const) : ('consistent-synthetic-scenario' as const),
    reasons,
    inputHash,
    simulatedAsOf,
    clockSource: 'synthetic-fixture' as const,
    ...safety,
  });
  if (!parsed.success) return finish(['INPUT_INVALID'], null, null);
  const value = parsed.data,
    { plan, before, after } = value,
    now = Date.parse(value.asOf);
  const reasons = new Set<Reason>();
  const add = (reason: Reason) => reasons.add(reason);
  if (value.scopeComplete !== 'simulated-confirmed') add('SCOPE_UNVERIFIED');
  if (before.authorityScopeHash !== plan.authorityScopeHash || after.authorityScopeHash !== plan.authorityScopeHash)
    add('SCOPE_MISMATCH');
  if (
    plan.nextGeneration !== plan.legacyGeneration + 1 ||
    [before, after].some(
      (s) =>
        s.generation !== plan.legacyGeneration ||
        s.accountVersion !== plan.accountVersion ||
        s.accountEpoch !== plan.accountEpoch,
    )
  )
    add('CONTROL_CONFLICT');
  const originals = (runs: PaperAuthorityFencingSimulationInput['before']['originalRuns']) => {
    let bytes = 0;
    if (new Set(runs.map((r) => r.runId)).size !== runs.length) add('ORIGINAL_SET_INVALID');
    const normalized = runs
      .map((r) => {
        const files = new Set(r.files.map((f) => f.name)),
          missing = new Set(r.missing);
        if (
          files.size !== r.files.length ||
          missing.size !== r.missing.length ||
          r.files.length === 0 ||
          [...missing].some((name) => files.has(name)) ||
          ['request.json', 'result.json', 'before.json', 'after.json', 'review.json'].some(
            (name) => !files.has(name) && !missing.has(name as (typeof r.missing)[number]),
          )
        )
          add('ORIGINAL_SET_INVALID');
        bytes += r.files.reduce((sum, f) => sum + f.bytes, 0);
        return {
          ...r,
          files: [...r.files].sort((a, b) => a.name.localeCompare(b.name)),
          missing: [...r.missing].sort(),
        };
      })
      .sort((a, b) => a.runId.localeCompare(b.runId));
    if (bytes > 64 * 1048576) add('ORIGINAL_SET_INVALID');
    return normalized;
  };
  const normalizedBefore = originals(before.originalRuns),
    normalizedAfter = originals(after.originalRuns);
  const { capturedAt: beforeCapturedAt, ...beforeState } = before;
  if (contentHash({ ...beforeState, originalRuns: normalizedBefore }) !== plan.baselineHash) add('BASELINE_MISMATCH');
  if (contentHash(normalizedBefore) !== contentHash(normalizedAfter)) add('ORIGINAL_EVIDENCE_CHANGED');
  if (before.businessLedgerHash !== after.businessLedgerHash) add('LEDGER_CHANGED');
  if (before.settingsHash !== after.settingsHash) add('SETTINGS_CHANGED');
  if (
    before.historicalRejectedCount !== after.historicalRejectedCount ||
    before.historicalUnresolvedCount !== after.historicalUnresolvedCount ||
    before.historicalRetiredCount !== after.historicalRetiredCount
  )
    add('HISTORY_CHANGED');
  if ([before, after].some((s) => !s.stopped || s.leasePresent || s.openIntents !== 0 || s.activeReservations !== 0))
    add('ACCOUNT_NOT_CLEAN');
  const beforeTime = Date.parse(beforeCapturedAt),
    afterTime = Date.parse(after.capturedAt);
  if (beforeTime > afterTime || afterTime > now) add('TIME_INVALID');
  const approvalKinds = value.approvals.map((a) => a.kind);
  if (!['policy', 'maintenance'].every((kind) => approvalKinds.includes(kind as (typeof approvalKinds)[number])))
    add('APPROVALS_MISSING');
  if (new Set(approvalKinds).size !== approvalKinds.length) add('APPROVAL_BINDING_INVALID');
  const planHash = contentHash(plan);
  for (const approval of value.approvals) {
    if (
      approval.planHash !== planHash ||
      approval.authorityScopeHash !== plan.authorityScopeHash ||
      approval.policyRevisionHash !== plan.policyRevisionHash ||
      approval.legacyGeneration !== plan.legacyGeneration ||
      approval.nextGeneration !== plan.nextGeneration
    )
      add('APPROVAL_BINDING_INVALID');
    if (
      Date.parse(approval.issuedAt) > beforeTime ||
      Date.parse(approval.expiresAt) <= now ||
      Date.parse(approval.expiresAt) <= Date.parse(approval.issuedAt)
    )
      add('TIME_INVALID');
  }
  const policy = value.approvals.find((a) => a.kind === 'policy'),
    maintenance = value.approvals.find((a) => a.kind === 'maintenance');
  if (policy && maintenance && Date.parse(policy.issuedAt) > Date.parse(maintenance.issuedAt)) add('TIME_INVALID');
  const domains = value.evidence.map((e) => e.domain),
    refs = value.evidence.map((e) => e.proofRef);
  if (!['runtime', 'database', 'broker'].every((domain) => domains.includes(domain as (typeof domains)[number])))
    add('EVIDENCE_MISSING');
  if (new Set(domains).size !== domains.length || new Set(refs).size !== refs.length) add('EVIDENCE_BINDING_INVALID');
  for (const evidence of value.evidence) {
    if (
      evidence.authorityScopeHash !== plan.authorityScopeHash ||
      evidence.legacyGeneration !== plan.legacyGeneration ||
      evidence.policyRevisionHash !== plan.policyRevisionHash ||
      evidence.planHash !== planHash
    )
      add('EVIDENCE_BINDING_INVALID');
    if (Object.values(evidence.checks).some((check) => check !== 'simulated-confirmed')) add('FENCE_UNVERIFIED');
    const effective = Date.parse(evidence.effectiveFrom),
      captured = Date.parse(evidence.capturedAt),
      until = Date.parse(evidence.validUntil);
    if (
      effective < beforeTime ||
      effective > captured ||
      captured > afterTime ||
      captured > now ||
      until <= now ||
      until <= captured
    )
      add('TIME_INVALID');
  }
  return finish([...reasons], contentHash(value), value.asOf);
}
