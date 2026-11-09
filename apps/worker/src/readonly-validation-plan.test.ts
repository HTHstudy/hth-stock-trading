import { createHash } from 'node:crypto';
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
it('계획에 예약 시각 자체를 남겨 다른 예약을 같은 내용으로 hash 고정하지 않는다', () => {
  const a = planReadonlyValidation({
    ...expiry,
    reservedWindows: [{ startsAt: '2026-11-04T19:00:00Z', endsAt: '2026-11-04T20:00:00Z' }],
  });
  const b = planReadonlyValidation({
    ...expiry,
    reservedWindows: [{ startsAt: '2026-11-04T18:00:00Z', endsAt: '2026-11-04T19:00:00Z' }],
  });
  expect(a.state).toBe('prepared');
  expect(b.state).toBe('prepared');
  expect(a.reservedWindows).not.toEqual(b.reservedWindows);
});

const regular = {
  kind: 'regular',
  startsAt: '2026-11-09T00:00:00Z',
  deadline: '2026-11-09T01:10:30Z',
  intervalSeconds: 60,
  sessionStartsAt: '2026-11-09T09:00:00+09:00',
  sessionEndsAt: '2026-11-09T15:30:00+09:00',
  reservedWindows: [],
};

it('정규장 60표본에 기존 startup/frame/cleanup 예산을 모두 포함한다', () => {
  expect(planReadonlyValidation(regular)).toMatchObject({
    kind: 'regular',
    state: 'prepared',
    samples: 60,
    regularOnly: true,
    targetThrough: '2026-11-09T00:59:00.000Z',
    minimumSamplingSpanMs: 3540000,
    plannedBudgetMs: 4230000,
    estimatedBudgetEndsAt: '2026-11-09T01:10:30.000Z',
    startupAllowanceMs: 30000,
    cleanupAllowanceMs: 60000,
    sampleTimeoutMs: 10000,
    sourceMethodCallsWithoutRetries: 300,
    observedTtlSeconds: null,
    boundaryAt: null,
    sessionStartsAt: '2026-11-09T00:00:00.000Z',
    sessionEndsAt: '2026-11-09T06:30:00.000Z',
    scheduled: false,
    executionEnabled: false,
    canResume: false,
  });
  expect(planReadonlyValidation({ ...regular, deadline: '2026-11-09T01:10:29.999Z' }).blockers).toContain(
    'DEADLINE_BUDGET_INSUFFICIENT',
  );
  const short = planReadonlyValidation({ ...regular, intervalSeconds: 10 });
  expect(short.samples).toBe(60);
  expect(short.targetThrough).toBe('2026-11-09T00:09:50.000Z');
  expect(short.plannedBudgetMs).toBe(1280000);
});

it('정규장 전체 start/deadline과 예약 겹침을 검사하고 종료 경계는 배제한다', () => {
  for (const change of [
    { startsAt: '2026-11-08T23:59:59.999Z' },
    { deadline: '2026-11-09T06:30:00Z' },
    { deadline: '2026-11-09T06:30:00.001Z' },
  ])
    expect(planReadonlyValidation({ ...regular, ...change }).blockers).toContain('OUTSIDE_REGULAR_SESSION');
  expect(planReadonlyValidation({ ...regular, deadline: '2026-11-09T06:29:59.999Z' }).state).toBe('prepared');
  expect(
    planReadonlyValidation({
      ...regular,
      reservedWindows: [{ startsAt: '2026-11-09T01:10:00Z', endsAt: '2026-11-09T02:00:00Z' }],
    }).blockers,
  ).toEqual(['RESERVED_WINDOW_OVERLAP']);
});

it('정규장 입력은 세션 양끝 ISO와 공통 필드만 허용한다', () => {
  for (const change of [
    { sessionStartsAt: undefined },
    { sessionEndsAt: undefined },
    { sessionStartsAt: 'invalid' },
    { sessionEndsAt: '2026-11-09' },
    { sessionEndsAt: regular.sessionStartsAt },
    { sessionStartsAt: regular.sessionEndsAt, sessionEndsAt: regular.sessionStartsAt },
    { observedTtlSeconds: 120 },
    { boundaryAt: regular.startsAt },
    { samples: 60 },
    { regularOnly: true },
    { observationJobId: 'kr-2026-11-09' },
  ])
    expect(() => planReadonlyValidation({ ...regular, ...change })).toThrow();
  for (const kind of ['session', 'expiry'])
    expect(() =>
      planReadonlyValidation({
        ...expiry,
        kind,
        sessionStartsAt: regular.sessionStartsAt,
        sessionEndsAt: regular.sessionEndsAt,
      }),
    ).toThrow();
});

it('기존 session/expiry 출력의 직렬화 hash와 세션 필드 생략을 보존한다', () => {
  const session = {
    kind: 'session',
    startsAt: '2026-11-04T20:55:00Z',
    boundaryAt: '2026-11-04T21:00:00Z',
    deadline: '2026-11-04T21:10:00Z',
    intervalSeconds: 30,
    reservedWindows: [],
  };
  for (const [input, hash] of [
    [expiry, '52f03a036cdd7349d37c59b2a947af4c3bbd5f81c9d8fc04ede4d9699e7568e8'],
    [session, 'f6f640f4f9666540d64d758fcd7d033cd7f1d7edce4514e2bbd04c1a3b2c0b09'],
  ] as const) {
    const plan = planReadonlyValidation(input);
    expect(createHash('sha256').update(JSON.stringify(plan)).digest('hex')).toBe(hash);
    expect(plan).not.toHaveProperty('sessionStartsAt');
    expect(plan).not.toHaveProperty('sessionEndsAt');
  }
});
