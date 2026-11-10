import { describe, expect, it } from 'vitest';
import { contentHash } from '@hth/database';
import { createPaperAuthorityFencingDemo, paperAuthorityFencingDemoCases } from './paper-authority-fencing-demo.js';
import { evaluatePaperAuthorityFencingSimulation } from './paper-authority-fencing-simulation.js';
import type { PaperAuthorityFencingSimulationInput } from './paper-authority-fencing-simulation-contracts.js';

const evaluate = evaluatePaperAuthorityFencingSimulation;
type Fixture = PaperAuthorityFencingSimulationInput;
const other = 'b'.repeat(64);
const at = (seconds: number) => new Date(Date.parse('2026-11-10T00:00:00.000Z') + seconds * 1000).toISOString();
const safe = {
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
};
const cases: [string, (f: Fixture) => void, string][] = [
  [
    'unknown scope',
    (f) => {
      f.scopeComplete = 'unverified';
    },
    'SCOPE_UNVERIFIED',
  ],
  [
    'before scope',
    (f) => {
      f.before.authorityScopeHash = other;
    },
    'SCOPE_MISMATCH',
  ],
  [
    'after scope',
    (f) => {
      f.after.authorityScopeHash = other;
    },
    'SCOPE_MISMATCH',
  ],
  [
    'generation skip',
    (f) => {
      f.plan.nextGeneration += 2;
    },
    'CONTROL_CONFLICT',
  ],
  [
    'before generation',
    (f) => {
      f.before.generation++;
    },
    'CONTROL_CONFLICT',
  ],
  [
    'after generation',
    (f) => {
      f.after.generation++;
    },
    'CONTROL_CONFLICT',
  ],
  [
    'version',
    (f) => {
      f.after.accountVersion++;
    },
    'CONTROL_CONFLICT',
  ],
  [
    'epoch',
    (f) => {
      f.after.accountEpoch++;
    },
    'CONTROL_CONFLICT',
  ],
  [
    'ledger',
    (f) => {
      f.after.businessLedgerHash = other;
    },
    'LEDGER_CHANGED',
  ],
  [
    'settings',
    (f) => {
      f.after.settingsHash = other;
    },
    'SETTINGS_CHANGED',
  ],
  [
    'rejected count',
    (f) => {
      f.after.historicalRejectedCount = 0;
    },
    'HISTORY_CHANGED',
  ],
  [
    'unresolved count',
    (f) => {
      f.after.historicalUnresolvedCount = 0;
    },
    'HISTORY_CHANGED',
  ],
  [
    'retired count',
    (f) => {
      f.after.historicalRetiredCount++;
    },
    'HISTORY_CHANGED',
  ],
  [
    'running',
    (f) => {
      f.after.stopped = false;
    },
    'ACCOUNT_NOT_CLEAN',
  ],
  [
    'lease',
    (f) => {
      f.before.leasePresent = true;
    },
    'ACCOUNT_NOT_CLEAN',
  ],
  [
    'open intent',
    (f) => {
      f.after.openIntents = 1;
    },
    'ACCOUNT_NOT_CLEAN',
  ],
  [
    'reservation',
    (f) => {
      f.after.activeReservations = 1;
    },
    'ACCOUNT_NOT_CLEAN',
  ],
  [
    'approval missing',
    (f) => {
      f.approvals.pop();
    },
    'APPROVALS_MISSING',
  ],
  [
    'approval duplicate',
    (f) => {
      f.approvals[1] = structuredClone(f.approvals[0]!);
    },
    'APPROVAL_BINDING_INVALID',
  ],
  [
    'approval hash',
    (f) => {
      f.approvals[0]!.planHash = other;
    },
    'APPROVAL_BINDING_INVALID',
  ],
  [
    'approval scope',
    (f) => {
      f.approvals[0]!.authorityScopeHash = other;
    },
    'APPROVAL_BINDING_INVALID',
  ],
  [
    'approval revision',
    (f) => {
      f.approvals[0]!.policyRevisionHash = other;
    },
    'APPROVAL_BINDING_INVALID',
  ],
  [
    'approval old generation',
    (f) => {
      f.approvals[0]!.legacyGeneration++;
    },
    'APPROVAL_BINDING_INVALID',
  ],
  [
    'approval new generation',
    (f) => {
      f.approvals[0]!.nextGeneration++;
    },
    'APPROVAL_BINDING_INVALID',
  ],
  [
    'approval expiry boundary',
    (f) => {
      f.approvals[0]!.expiresAt = f.asOf;
    },
    'TIME_INVALID',
  ],
  [
    'approval after snapshot',
    (f) => {
      f.approvals[0]!.issuedAt = at(3);
    },
    'TIME_INVALID',
  ],
  [
    'approval order',
    (f) => {
      f.approvals[0]!.issuedAt = at(1.5);
    },
    'TIME_INVALID',
  ],
  [
    'approval inverted',
    (f) => {
      f.approvals[0]!.expiresAt = at(-1);
    },
    'TIME_INVALID',
  ],
  [
    'evidence missing',
    (f) => {
      f.evidence.pop();
    },
    'EVIDENCE_MISSING',
  ],
  [
    'evidence duplicate',
    (f) => {
      f.evidence[2] = structuredClone(f.evidence[0]!);
    },
    'EVIDENCE_BINDING_INVALID',
  ],
  [
    'proof reuse',
    (f) => {
      f.evidence[1]!.proofRef = f.evidence[0]!.proofRef;
    },
    'EVIDENCE_BINDING_INVALID',
  ],
  [
    'evidence scope',
    (f) => {
      f.evidence[0]!.authorityScopeHash = other;
    },
    'EVIDENCE_BINDING_INVALID',
  ],
  [
    'evidence generation',
    (f) => {
      f.evidence[1]!.legacyGeneration++;
    },
    'EVIDENCE_BINDING_INVALID',
  ],
  [
    'evidence revision',
    (f) => {
      f.evidence[2]!.policyRevisionHash = other;
    },
    'EVIDENCE_BINDING_INVALID',
  ],
  [
    'fence before maintenance',
    (f) => {
      f.evidence[0]!.effectiveFrom = at(1);
    },
    'TIME_INVALID',
  ],
  [
    'fence after capture',
    (f) => {
      f.evidence[0]!.effectiveFrom = at(5);
    },
    'TIME_INVALID',
  ],
  [
    'fence future',
    (f) => {
      f.evidence[0]!.capturedAt = at(7);
    },
    'TIME_INVALID',
  ],
  [
    'fence after final snapshot',
    (f) => {
      f.evidence[0]!.capturedAt = at(5.5);
    },
    'TIME_INVALID',
  ],
  [
    'fence expired',
    (f) => {
      f.evidence[0]!.validUntil = f.asOf;
    },
    'TIME_INVALID',
  ],
  [
    'snapshot backward',
    (f) => {
      f.after.capturedAt = at(1);
    },
    'TIME_INVALID',
  ],
  [
    'snapshot future',
    (f) => {
      f.after.capturedAt = at(7);
    },
    'TIME_INVALID',
  ],
  [
    'changed bytes',
    (f) => {
      f.after.originalRuns[0]!.files[0]!.bytes++;
    },
    'ORIGINAL_EVIDENCE_CHANGED',
  ],
  [
    'changed sha',
    (f) => {
      f.after.originalRuns[0]!.files[0]!.sha256 = other;
    },
    'ORIGINAL_EVIDENCE_CHANGED',
  ],
  [
    'missing set',
    (f) => {
      f.after.originalRuns[0]!.missing.pop();
    },
    'ORIGINAL_SET_INVALID',
  ],
  [
    'duplicate run',
    (f) => {
      f.after.originalRuns.push(structuredClone(f.after.originalRuns[0]!));
    },
    'ORIGINAL_SET_INVALID',
  ],
  [
    'duplicate file',
    (f) => {
      f.after.originalRuns[0]!.files.push(structuredClone(f.after.originalRuns[0]!.files[0]!));
    },
    'ORIGINAL_SET_INVALID',
  ],
  [
    'duplicate missing',
    (f) => {
      f.after.originalRuns[0]!.missing.push('request.json');
    },
    'ORIGINAL_SET_INVALID',
  ],
  [
    'file marked missing',
    (f) => {
      f.after.originalRuns[0]!.missing.push('result.json');
    },
    'ORIGINAL_SET_INVALID',
  ],
  [
    'new unknown run',
    (f) => {
      f.after.originalRuns.push({
        ...structuredClone(f.after.originalRuns[0]!),
        runId: '20000000-0000-4000-8000-000000000002',
      });
    },
    'ORIGINAL_EVIDENCE_CHANGED',
  ],
  [
    'hidden removed run',
    (f) => {
      f.before.originalRuns.push({
        ...structuredClone(f.before.originalRuns[0]!),
        runId: '20000000-0000-4000-8000-000000000002',
      });
    },
    'ORIGINAL_EVIDENCE_CHANGED',
  ],
  [
    'aggregate size limit',
    (f) => {
      const r = f.before.originalRuns[0]!;
      r.files.push(
        ...['diagnostics.json', 'failure-after.json', 'warmup-plan.json'].map((name) => ({
          name,
          bytes: 32 * 1048576,
          sha256: other,
        })),
      );
    },
    'ORIGINAL_SET_INVALID',
  ],
];
it('완비 합성 사례도 실제 권한을 인증하거나 원본 입력을 변경하지 않는다', () => {
  const fixture = createPaperAuthorityFencingDemo(),
    before = structuredClone(fixture),
    result = evaluate(fixture);
  expect(result).toMatchObject({
    ...safe,
    state: 'consistent-synthetic-scenario',
    reasons: [],
    inputHash: contentHash(fixture),
    simulatedAsOf: fixture.asOf,
  });
  expect(fixture).toEqual(before);
  expect(evaluate(fixture)).toEqual(result);
  expect(JSON.stringify(result)).not.toMatch(/fixture:|runId|scope|collector|proofRef|postgres|token/);
});
it.each(cases)('%s은 합성 일치로 처리하지 않는다', (_label, change, reason) => {
  const fixture = createPaperAuthorityFencingDemo();
  change(fixture);
  const before = structuredClone(fixture),
    result = evaluate(fixture);
  expect(result).toMatchObject({ ...safe, state: 'blocked' });
  expect(result.reasons).toContain(reason);
  expect(fixture).toEqual(before);
});
describe('각 경계의 모든 세부 조건', () => {
  const baseline = createPaperAuthorityFencingDemo();
  for (const receipt of baseline.evidence)
    for (const name of Object.keys(receipt.checks))
      it.each(['simulated-failed', 'missing', 'unverified'])(`${receipt.domain}/${name}=%s는 차단`, (value) => {
        const fixture = createPaperAuthorityFencingDemo(),
          target = fixture.evidence.find((e) => e.domain === receipt.domain)!;
        Object.assign(target.checks, { [name]: value });
        expect(evaluate(fixture)).toMatchObject({
          ...safe,
          state: 'blocked',
          reasons: expect.arrayContaining(['FENCE_UNVERIFIED']),
        });
      });
});
it.each([
  null,
  {},
  { source: 'market' },
  { ...createPaperAuthorityFencingDemo(), source: 'market' },
  { ...createPaperAuthorityFencingDemo(), mode: 'live' },
  { ...createPaperAuthorityFencingDemo(), accountId: 'PRIVATE_ACCOUNT' },
  { ...createPaperAuthorityFencingDemo(), token: 'PRIVATE_TOKEN' },
  { ...createPaperAuthorityFencingDemo(), asOf: '2026-11-10T00:00:06.000001Z' },
])('알 수 없는 실제/위험 입력을 원문 없이 거부한다', (input) => {
  const result = evaluate(input);
  expect(result).toMatchObject({
    ...safe,
    state: 'blocked',
    reasons: ['INPUT_INVALID'],
    inputHash: null,
    simulatedAsOf: null,
  });
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE|invalid_type|accountId/);
});
it('불리언 회수 주장·원본 경로·과도한 크기는 계약 밖이다', () => {
  for (const mutate of [
    (f: Fixture) => {
      Object.assign(f.evidence[0]!.checks, { launchDenied: true });
    },
    (f: Fixture) => {
      f.after.originalRuns[0]!.files[0]!.name = '../private.json';
    },
    (f: Fixture) => {
      f.after.originalRuns[0]!.files[0]!.bytes = 32 * 1048576 + 1;
    },
    (f: Fixture) => {
      f.plan.accountVersion = Number.MAX_SAFE_INTEGER;
    },
  ]) {
    const f = createPaperAuthorityFencingDemo();
    mutate(f);
    expect(evaluate(f).reasons).toEqual(['INPUT_INVALID']);
  }
});
it('원본 목록과 누락 목록 순서만 달라진 경우 이력 변경으로 오인하지 않는다', () => {
  const f = createPaperAuthorityFencingDemo();
  f.after.originalRuns[0]!.missing.reverse();
  expect(evaluate(f)).toMatchObject({ ...safe, state: 'consistent-synthetic-scenario', reasons: [] });
});
it('내장 데모는 매번 독립 데이터이며 변경/실패 상태를 외부 승인으로 바꾸지 않는다', () => {
  for (const name of paperAuthorityFencingDemoCases) {
    const f = createPaperAuthorityFencingDemo(name),
      r = evaluate(f);
    expect(r).toMatchObject(safe);
    expect(r.state).toBe(name === 'complete' ? 'consistent-synthetic-scenario' : 'blocked');
  }
  const f = createPaperAuthorityFencingDemo();
  f.before.originalRuns[0]!.files[0]!.sha256 = other;
  expect(createPaperAuthorityFencingDemo().before.originalRuns[0]!.files[0]!.sha256).not.toBe(other);
});
it.each(['ledger', 'inventory', 'settings', 'counts'])(
  '전후 %s를 같이 바꿔도 승인된 기준 hash와 다르면 거부한다',
  (kind) => {
    const f = createPaperAuthorityFencingDemo();
    for (const snapshot of [f.before, f.after]) {
      if (kind === 'ledger') snapshot.businessLedgerHash = other;
      if (kind === 'inventory') snapshot.originalRuns[0]!.files[0]!.sha256 = other;
      if (kind === 'settings') snapshot.settingsHash = other;
      if (kind === 'counts') snapshot.historicalUnresolvedCount = 0;
    }
    expect(evaluate(f)).toMatchObject({
      ...safe,
      state: 'blocked',
      reasons: expect.arrayContaining(['BASELINE_MISMATCH']),
    });
  },
);
it('가짜 hash·승인·근거를 전부 일관되게 만들어도 실제 권한 인증은 항상 false다', () => {
  const f = createPaperAuthorityFencingDemo();
  f.before.businessLedgerHash = other;
  f.after.businessLedgerHash = other;
  f.plan.baselineHash = contentHash(
    Object.fromEntries(Object.entries(f.before).filter(([key]) => key !== 'capturedAt')),
  );
  for (const approval of f.approvals) approval.planHash = contentHash(f.plan);
  for (const evidence of f.evidence) evidence.planHash = contentHash(f.plan);
  expect(evaluate(f)).toMatchObject({ ...safe, state: 'consistent-synthetic-scenario', reasons: [] });
});
it('승인 기준도 파일/누락 목록의 표현 순서와 독립적으로 비교한다', () => {
  const f = createPaperAuthorityFencingDemo();
  f.before.originalRuns[0]!.missing.reverse();
  expect(evaluate(f)).toMatchObject({ ...safe, state: 'consistent-synthetic-scenario', reasons: [] });
});
it('새 기준/제어 계획으로 다시 승인해도 이전 계획의 근거는 재사용하지 않는다', () => {
  const f = createPaperAuthorityFencingDemo();
  f.before.accountVersion++;
  f.after.accountVersion++;
  f.plan.accountVersion++;
  f.plan.baselineHash = contentHash(
    Object.fromEntries(Object.entries(f.before).filter(([key]) => key !== 'capturedAt')),
  );
  for (const approval of f.approvals) approval.planHash = contentHash(f.plan);
  expect(evaluate(f)).toMatchObject({
    ...safe,
    state: 'blocked',
    reasons: expect.arrayContaining(['EVIDENCE_BINDING_INVALID']),
  });
});
