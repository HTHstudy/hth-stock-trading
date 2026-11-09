import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  paperValidationFailureCodeSchema,
  paperValidationRunSchema,
  paperValidationStatusSchema,
} from './paper-validation-status.js';

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
it('확정 봉 부족과 일반 사전 점검 실패 코드를 구분하고 알 수 없는 코드는 거부한다', () => {
  for (const code of [
    'PAPER_STRATEGY_WARMUP_INSUFFICIENT',
    'PAPER_PREFLIGHT_FAILED',
    'PAPER_VALIDATION_PAUSED',
    'PAPER_VALIDATION_WAITING',
    'PAPER_CONTINUATION_INVALID',
  ]) {
    expect(paperValidationFailureCodeSchema.parse(code)).toBe(code);
    const saved = paperValidationRunSchema.parse({
      ...row(),
      market: 'US',
      state: 'terminal-recorded',
      resultState: 'stopped-before-run-or-failed',
      finishedAt: '2026-11-03T01:00:00Z',
      completedTicks: 0,
      code,
      stoppedAndCleaned: true,
    });
    expect(saved.code).toBe(code);
    expect(saved.canResume).toBe(false);
    expect(saved.executionEnabled).toBe(false);
  }
  expect(paperValidationFailureCodeSchema.safeParse('PAPER_STRATEGY_WARMUP_NOT_READY').success).toBe(false);
  expect(paperValidationRunSchema.safeParse({ ...row(), code: 'PAPER_STRATEGY_WARMUP_INSUFFICIENT' }).success).toBe(
    false,
  );
});
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
