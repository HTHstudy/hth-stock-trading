import { expect, it } from 'vitest';
import type { MarketCalendar } from '@hth/contracts';
import { requireObservationSession, waitForObservationStart } from './market-observation-start.js';

it('대기는 짧은 구간으로 나누고 예정 시각 뒤 수집을 허용한다', async () => {
  let clock = Date.parse('2026-10-29T13:33:00Z');
  const waits: number[] = [];
  await waitForObservationStart(
    '2026-10-29T13:35:00Z',
    new AbortController().signal,
    () => clock,
    async (ms) => {
      waits.push(ms);
      clock += ms;
    },
  );
  expect(waits).toEqual([30000, 30000, 30000, 30000]);
});
it('절전으로 시작을 놓치거나 36시간 밖이면 실행을 거부한다', async () => {
  const start = Date.parse('2026-10-29T13:35:00Z');
  await expect(
    waitForObservationStart(new Date(start).toISOString(), new AbortController().signal, () => start + 120001),
  ).rejects.toThrow('OBSERVATION_START_MISSED');
  await expect(
    waitForObservationStart(new Date(start).toISOString(), new AbortController().signal, () => start - 37 * 3600000),
  ).rejects.toThrow('MARKET_OBSERVATION_CONFIGURATION_INVALID');
});
it('예정 시각 대기 중 취소하면 실행 단계로 넘어가지 않는다', async () => {
  const control = new AbortController();
  await expect(
    waitForObservationStart(
      '2026-10-29T13:35:00Z',
      control.signal,
      () => Date.parse('2026-10-29T13:34:00Z'),
      async () => {
        control.abort();
      },
    ),
  ).rejects.toThrow();
});
const day = {
  market: 'US' as const,
  tradingDate: '2026-10-29',
  sessionsKnown: true,
  sessions: [{ type: 'regular' as const, startsAt: '2026-10-29T13:30:00Z', endsAt: '2026-10-29T20:00:00Z' }],
};
const calendar: MarketCalendar = { today: day, previousBusinessDay: day, nextBusinessDay: day };
const settings = { samples: 60, intervalMs: 60000, timeoutMs: 10000 };
it('신선한 캘린더의 현재 정규장에 수집 예산이 모두 들어갈 때만 시작한다', () => {
  expect(() => requireObservationSession(calendar, 'US', settings, Date.parse('2026-10-29T13:35:00Z'))).not.toThrow();
  for (const time of ['2026-10-29T13:00:00Z', '2026-10-29T19:00:00Z', '2026-10-29T20:01:00Z'])
    expect(() => requireObservationSession(calendar, 'US', settings, Date.parse(time))).toThrow(
      'OBSERVATION_SESSION_UNAVAILABLE',
    );
  for (const today of [
    { ...day, sessionsKnown: false },
    { ...day, sessions: [] },
    { ...day, market: 'KR' as const },
  ])
    expect(() =>
      requireObservationSession({ ...calendar, today }, 'US', settings, Date.parse('2026-10-29T13:35:00Z')),
    ).toThrow('OBSERVATION_SESSION_UNAVAILABLE');
});
