import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { planReadonlyValidation } from './readonly-validation-plan.js';

const expiry = {
  kind: 'expiry',
  startsAt: '2026-11-04T21:15:00Z',
  deadline: '2026-11-05T22:30:00Z',
  intervalSeconds: 300,
  observedTtlSeconds: 86399,
  reservedWindows: [],
};
it('실제 TTL 입력과 완료 후 간격·수집 시간을 예산에 반영한다', () => {
  const plan = planReadonlyValidation(expiry);
  expect(plan).toMatchObject({
    state: 'prepared',
    samples: 290,
    plannedBudgetMs: 89690000,
    sourceMethodCallsWithoutRetries: 1450,
    httpRequestCountKnown: false,
    scheduled: false,
    executionEnabled: false,
    requiresDeadlineSupervisor: true,
  });
  expect(planReadonlyValidation({ ...expiry, observedTtlSeconds: 120 }).samples).toBe(2);
  expect(planReadonlyValidation({ ...expiry, deadline: '2026-11-05T21:20:00Z' }).blockers).toContain(
    'DEADLINE_BUDGET_INSUFFICIENT',
  );
});
it('세션 경계 전후를 포함하고 완료 후 간격의 누적 지연을 계산한다', () => {
  const plan = planReadonlyValidation({
    kind: 'session',
    startsAt: '2026-11-04T20:55:00Z',
    boundaryAt: '2026-11-04T21:00:00Z',
    deadline: '2026-11-04T21:10:00Z',
    intervalSeconds: 30,
    reservedWindows: [],
  });
  expect(plan).toMatchObject({ state: 'prepared', samples: 21, plannedBudgetMs: 900000, regularOnly: false });
  expect(() =>
    planReadonlyValidation({
      kind: 'session',
      startsAt: '2026-11-04T21:00:00Z',
      boundaryAt: '2026-11-04T21:00:00Z',
      deadline: '2026-11-04T21:10:00Z',
      intervalSeconds: 30,
      reservedWindows: [],
    }),
  ).toThrow('INSUFFICIENT_PRE_BOUNDARY_WINDOW');
});
it('실행 전체와 예약의 포함·부분 겹침을 거부하고 접한 구간은 허용한다', () => {
  for (const window of [
    { startsAt: '2026-11-04T22:00:00Z', endsAt: '2026-11-04T23:00:00Z' },
    { startsAt: '2026-11-04T20:00:00Z', endsAt: '2026-11-06T00:00:00Z' },
    { startsAt: '2026-11-05T22:29:00Z', endsAt: '2026-11-05T23:00:00Z' },
  ])
    expect(planReadonlyValidation({ ...expiry, reservedWindows: [window] }).blockers).toContain(
      'RESERVED_WINDOW_OVERLAP',
    );
  expect(
    planReadonlyValidation({
      ...expiry,
      reservedWindows: [{ startsAt: '2026-11-04T20:00:00Z', endsAt: expiry.startsAt }],
    }).state,
  ).toBe('prepared');
});
it('잘못된 시각·무한 계획·횟수 초과·미정 입력을 거부한다', () => {
  for (const change of [
    { startsAt: 'not-a-date' },
    { deadline: expiry.startsAt },
    { deadline: '2026-11-07T00:00:00Z' },
    { observedTtlSeconds: 0 },
    { observedTtlSeconds: 172800, intervalSeconds: 10 },
    { intervalSeconds: 9 },
    { accountId: 'not-allowed' },
    { reservedWindows: [{ startsAt: expiry.deadline, endsAt: expiry.startsAt }] },
  ])
    expect(() => planReadonlyValidation({ ...expiry, ...change })).toThrow();
});
it('CLI 미리보기는 서버 환경파일 없이 동작하고 실행 옵션을 거부한다', () => {
  const cli = resolve('apps/worker/dist/readonly-validation-plan-run.js');
  const preview = JSON.parse(execFileSync(process.execPath, [cli], { env: {}, encoding: 'utf8' }));
  expect(preview).toMatchObject({ state: 'preview', scheduled: false, executionEnabled: false });
  expect(() => execFileSync(process.execPath, [cli, '--execute'], { env: {}, stdio: 'pipe' })).toThrow();
  expect(() =>
    execFileSync(process.execPath, [cli, '--kind=expiry', '--kind=session'], { env: {}, stdio: 'pipe' }),
  ).toThrow();
});
