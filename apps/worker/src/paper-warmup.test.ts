import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { planPaperWarmup, assessPaperWarmup } from './paper-warmup.js';

const session = {
  parameters: { fastPeriod: 5, slowPeriod: 20 },
  sessionStartsAt: '2026-11-05T14:30:00Z',
  sessionEndsAt: '2026-11-05T21:00:00Z',
};
it('미국 개장 5분 뒤의 확정봉 4개 실패를 예약 전에 잡고 25분 뒤를 제안한다', () => {
  expect(planPaperWarmup({ ...session, requestedStartAt: '2026-11-05T14:35:00Z' })).toMatchObject({
    state: 'blocked',
    requiredCandles: 21,
    theoreticalClosedCandlesAtStart: 4,
    earliestEligibleAt: '2026-11-05T14:52:00.000Z',
    warmupRecommendedStartAt: '2026-11-05T14:55:00.000Z',
    recommendedStartAt: '2026-11-05T15:05:00.000Z',
    blockers: expect.arrayContaining(['WARMUP_TIME_TOO_EARLY']),
  });
  expect(planPaperWarmup(session)).toMatchObject({
    state: 'prepared',
    startsAt: '2026-11-05T15:05:00.000Z',
    deadline: '2026-11-05T15:30:00.000Z',
    theoreticalClosedCandlesAtStart: 34,
    actualCandlesVerified: false,
    scheduled: false,
    executionEnabled: false,
    canResume: false,
  });
});
it('봉 재관측 60초 경계와 전략별 필요 수를 반영한다', () => {
  expect(planPaperWarmup({ ...session, requestedStartAt: '2026-11-05T14:51:59.999Z' }).state).toBe('blocked');
  expect(planPaperWarmup({ ...session, requestedStartAt: '2026-11-05T14:52:00Z' })).toMatchObject({
    state: 'blocked',
    theoreticalClosedCandlesAtStart: 21,
    blockers: ['TRADING_DAY_BOUNDARY'],
  });
  expect(planPaperWarmup({ ...session, parameters: { fastPeriod: 2, slowPeriod: 5 } })).toMatchObject({
    requiredCandles: 6,
    warmupRecommendedStartAt: '2026-11-05T14:40:00.000Z',
  });
  expect(planPaperWarmup({ ...session, sessionStartsAt: '2026-11-05T14:30:30Z' }).earliestEligibleAt).toBe(
    '2026-11-05T14:53:00.000Z',
  );
});
it('고정 UTC 세션으로 DST·조기 폐장과 국내장도 처리하고 기한 예산을 지킨다', () => {
  expect(
    planPaperWarmup({ ...session, sessionStartsAt: '2026-07-01T13:30:00Z', sessionEndsAt: '2026-07-01T20:00:00Z' })
      .startsAt,
  ).toBe('2026-07-01T13:55:00.000Z');
  expect(
    planPaperWarmup({ ...session, sessionStartsAt: '2026-11-05T00:00:00Z', sessionEndsAt: '2026-11-05T06:30:00Z' })
      .startsAt,
  ).toBe('2026-11-05T00:25:00.000Z');
  expect(planPaperWarmup({ ...session, sessionEndsAt: '2026-11-05T14:55:00Z' }).state).toBe('blocked');
  expect(planPaperWarmup({ ...session, requestedStartAt: '2026-11-05T20:50:00Z' }).blockers).toContain(
    'DEADLINE_OUTSIDE_SESSION',
  );
  for (const patch of [
    { sessionEndsAt: session.sessionStartsAt },
    { parameters: { fastPeriod: 20, slowPeriod: 5 } },
    { parameters: { fastPeriod: 5, slowPeriod: 200 } },
    { sessionStartsAt: 'not-a-time' },
  ])
    expect(() => planPaperWarmup({ ...session, ...patch })).toThrow();
});
it('실제 fresh 준비 입력을 종목/전략별로 검사하고 최대 slowPeriod를 다른 종목에 강요하지 않는다', () => {
  const us = { market: 'US', symbol: 'AAPL' },
    kr = { market: 'KR', symbol: '005930' };
  const strategies = [
    { instrument: us, parameters: { fastPeriod: 5, slowPeriod: 20 } },
    { instrument: kr, parameters: { fastPeriod: 2, slowPeriod: 5 } },
  ];
  const frames = [
    { instrument: kr, dataReady: true, closedCandles: 6 },
    { instrument: us, dataReady: true, closedCandles: 21 },
  ];
  expect(assessPaperWarmup(strategies, frames)).toMatchObject({
    ready: true,
    executionEnabled: false,
    canResume: false,
  });
  expect(assessPaperWarmup(strategies, [{ ...frames[0]!, closedCandles: 5 }, frames[1]!])).toMatchObject({
    ready: false,
    reports: [
      { ready: true },
      { requiredCandles: 6, availableCandles: 5, missingCandles: 1, reason: 'INSUFFICIENT_CANDLES' },
    ],
  });
  expect(assessPaperWarmup(strategies, [{ ...frames[0]!, dataReady: false }, frames[1]!]).reports[1]!.reason).toBe(
    'DATA_NOT_READY',
  );
  expect(assessPaperWarmup(strategies, [frames[1]!]).ready).toBe(false);
  expect(() => assessPaperWarmup(strategies, [frames[1]!, frames[1]!])).toThrow();
});
it('CLI는 키/DB 없는 계획만 만들고 실제 실행 옵션을 거부한다', () => {
  const cli = resolve('apps/worker/dist/paper-warmup-run.js');
  expect(JSON.parse(execFileSync(process.execPath, [cli], { env: {}, encoding: 'utf8' }))).toMatchObject({
    state: 'preview',
    executionEnabled: false,
  });
  expect(() => execFileSync(process.execPath, [cli, '--execute'], { env: {}, stdio: 'pipe' })).toThrow();
  expect(() =>
    execFileSync(process.execPath, [cli, '--session-start=x', '--session-start=y'], { env: {}, stdio: 'pipe' }),
  ).toThrow();
});

it('한국 자정과 미국 20시 거래일 전환을 실행 창 전체에서 회피하고 일일 손실 정책을 바꾸지 않는다', () => {
  expect(planPaperWarmup(session)).toMatchObject({
    state: 'prepared',
    dayBoundaryAdjusted: true,
    startsAt: '2026-11-05T15:05:00.000Z',
    deadline: '2026-11-05T15:30:00.000Z',
    dailyDatesAtStart: { KRW: '2026-11-06', USD: '2026-11-05' },
  });
  expect(planPaperWarmup({ ...session, requestedStartAt: '2026-11-05T14:55:00Z' }).blockers).toContain(
    'TRADING_DAY_BOUNDARY',
  );
  expect(
    planPaperWarmup({ ...session, requestedStartAt: '2026-11-05T14:52:00Z', deadline: '2026-11-05T14:59:00Z' })
      .blockers,
  ).toContain('PROCEDURE_BUDGET_TOO_SHORT');
  const kr = {
    ...session,
    parameters: { fastPeriod: 5, slowPeriod: 46 },
    sessionStartsAt: '2026-11-05T00:00:00Z',
    sessionEndsAt: '2026-11-05T06:30:00Z',
  };
  expect(planPaperWarmup(kr)).toMatchObject({
    state: 'prepared',
    warmupRecommendedStartAt: '2026-11-05T00:51:00.000Z',
    startsAt: '2026-11-05T01:05:00.000Z',
    dailyDatesAtStart: { KRW: '2026-11-05', USD: '2026-11-05' },
  });
});
