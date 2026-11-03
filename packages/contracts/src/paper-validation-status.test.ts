import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { paperValidationRunSchema, paperValidationStatusSchema } from './paper-validation-status.js';

function row() {
  return {
    id: randomUUID(),
    market: 'KR',
    startsAt: null,
    deadline: '2026-11-03T02:00:00Z',
    state: 'awaiting-result',
    resultState: null,
    deadlineElapsed: true,
    clock: 'not-in-future',
    finishedAt: null,
    code: null,
    completedTicks: null,
    runningTicks: null,
    evidence: 'request-only',
    verdict: null,
    checks: null,
    observedCounts: null,
    stoppedAndCleaned: null,
    executionEnabled: false,
    canResume: false,
    processLivenessChecked: false,
    ledgerReviewRecomputed: false,
  };
}
it('종료 없는 요청과 기한 경과를 실행/실패로 승격하지 않고 읽기 전용 계약을 유지한다', () => {
  const value = row();
  expect(paperValidationRunSchema.parse(value)).toEqual(value);
  expect(
    paperValidationStatusSchema.parse({
      service: 'paper-validation-status',
      asOf: '2026-11-03T01:00:00Z',
      availability: 'available',
      runs: [value],
      rejectedCount: 0,
      limited: false,
      executionEnabled: false,
      canResume: false,
    }).runs,
  ).toHaveLength(1);
});
it('계좌·경로·PID·토큰 및 실행 권한 필드를 차단한다', () => {
  for (const extra of [
    { accountId: 'PRIVATE' },
    { path: '/private/file' },
    { pid: 123 },
    { token: 'SECRET' },
    { canResume: true },
    { executionEnabled: true },
    { processLivenessChecked: true },
  ])
    expect(paperValidationRunSchema.safeParse({ ...row(), ...extra }).success).toBe(false);
});
it('종료·대사·tick 수의 모순을 거부한다', () => {
  for (const extra of [
    { resultState: 'completed' },
    { state: 'terminal-recorded' },
    { evidence: 'linked-review' },
    { completedTicks: 61 },
    { completedTicks: 1, runningTicks: 2 },
    { checks: { secretKey: 'passed' } },
  ])
    expect(paperValidationRunSchema.safeParse({ ...row(), ...extra }).success).toBe(false);
});
it('오류 root의 결과 및 반환/제외 상한 위반을 거부한다', () => {
  const status = {
    service: 'paper-validation-status',
    asOf: '2026-11-03T01:00:00Z',
    availability: 'unavailable',
    runs: [],
    rejectedCount: 0,
    limited: false,
    executionEnabled: false,
    canResume: false,
  };
  expect(paperValidationStatusSchema.safeParse(status).success).toBe(true);
  for (const changed of [
    { ...status, runs: [row()] },
    { ...status, rejectedCount: 101 },
    { ...status, availability: 'available', runs: Array.from({ length: 51 }, row) },
  ])
    expect(paperValidationStatusSchema.safeParse(changed).success).toBe(false);
});
