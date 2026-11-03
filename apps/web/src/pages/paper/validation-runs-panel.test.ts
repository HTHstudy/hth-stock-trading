import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { paperValidationStatusSchema, paperValidationCheckNames } from '@hth/contracts';
import type { PaperValidationRun, PaperValidationStatus } from '@hth/contracts';
import { ValidationRunsPanel } from './validation-runs-panel.js';

const asOf = '2026-11-03T00:00:00.000Z';
const queryKey = ['paper-validation-runs'];
function run(overrides: Partial<PaperValidationRun> = {}): PaperValidationRun {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    market: 'KR',
    startsAt: asOf,
    deadline: '2026-11-03T01:00:00.000Z',
    state: 'terminal-recorded',
    resultState: 'completed-with-incomplete-review',
    deadlineElapsed: false,
    clock: 'not-in-future',
    finishedAt: asOf,
    code: null,
    completedTicks: 60,
    runningTicks: 59,
    evidence: 'linked-review',
    verdict: 'incomplete',
    checks: { stopped: 'passed', fillPath: 'unverified', cashMatchesFills: 'failed' },
    observedCounts: {
      newIntents: 0,
      newFills: 0,
      newObservations: 1,
      newDiagnostics: 1,
      leaseAcquisitions: 1,
      leaseReleases: 1,
    },
    stoppedAndCleaned: true,
    executionEnabled: false,
    canResume: false,
    processLivenessChecked: false,
    ledgerReviewRecomputed: false,
    ...overrides,
  };
}
function snapshot(overrides: Partial<PaperValidationStatus> = {}): PaperValidationStatus {
  return paperValidationStatusSchema.parse({
    service: 'paper-validation-status',
    asOf,
    availability: 'available',
    runs: [run()],
    rejectedCount: 0,
    limited: false,
    executionEnabled: false,
    canResume: false,
    ...overrides,
  });
}
function render(value?: PaperValidationStatus, mode: 'ok' | 'error' | 'expired' = 'ok') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  try {
    if (value) client.setQueryData(queryKey, value, { updatedAt: Date.now() - (mode === 'expired' ? 30000 : 0) });
    if (mode === 'error')
      client
        .getQueryCache()
        .find({ queryKey })!
        .setState({ status: 'error', error: new Error('PRIVATE_ERROR_TEXT'), fetchStatus: 'idle' });
    return renderToString(
      createElement(QueryClientProvider, { client, children: createElement(ValidationRunsPanel) }),
    ).replace(/<!--.*?-->/g, '');
  } finally {
    client.clear();
  }
}
afterEach(() => {
  vi.unstubAllGlobals();
});

it('저장 fixture만 SSR하고 조회나 broker 연결을 시작하지 않는다', () => {
  const fetch = vi.fn(() => {
    throw new Error('Unexpected network');
  });
  vi.stubGlobal('fetch', fetch);
  const html = render(snapshot());
  expect(fetch).not.toHaveBeenCalled();
  expect(html).toContain('국내 (KR)');
  expect(html).toContain('미국 (US)');
  expect(html).toContain('대사 미완료');
  expect(html).toContain('완료 60');
  expect(html).toContain('실행 상태 보고 59');
  expect(html).toContain('모의 체결 경로: 미검증');
  expect(html).toContain('현금과 체결 일치: 문제 발견');
  expect(html).toContain('정지·정리 기록 있음');
  expect(html).toContain('현재 실행 여부는 미확인');
  expect(html).toContain('조회에서 다시 계산하지 않습니다');
  expect(html).not.toContain('text-teal-200');
  expect(html.match(/<button/g)).toHaveLength(1);
  expect(html).toContain('실행 기록 새로고침');
  for (const forbidden of [
    '최신순',
    '재개하기',
    '중단하기',
    '계좌 ID',
    'lease token',
    'PID',
    '/private/',
    'postgres://',
  ])
    expect(html).not.toContain(forbidden);
});
it('기록 없음과 자료 접근 불가를 구분한다', () => {
  const missing = render(snapshot({ availability: 'not-recorded', runs: [] }));
  expect(missing).toContain('저장된 실행 기록이 없습니다');
  const unavailable = render(snapshot({ availability: 'unavailable', runs: [] }));
  expect(unavailable).toContain('기록 없음과 다릅니다');
  expect(unavailable).not.toContain('저장된 실행 기록이 없습니다');
});
it('조회 오류 또는 정확히 30초 지난 캐시에 남은 정상 자료를 숨긴다', () => {
  for (const mode of ['error', 'expired'] as const) {
    const html = render(snapshot(), mode);
    expect(html).toContain('이전 정상 결과를 숨겼습니다');
    expect(html).not.toContain('증거 묶음');
    expect(html).not.toContain('대사 미완료');
    expect(html).not.toContain('PRIVATE_ERROR_TEXT');
  }
});
it('기한 경과와 종료 기록 없음으로 실행 중이나 실패를 추정하지 않는다', () => {
  const html = render(
    snapshot({
      runs: [
        run({
          state: 'awaiting-result',
          resultState: null,
          finishedAt: null,
          completedTicks: null,
          runningTicks: null,
          evidence: 'request-only',
          verdict: null,
          checks: null,
          observedCounts: null,
          stoppedAndCleaned: null,
          deadlineElapsed: true,
        }),
      ],
    }),
  );
  expect(html).toContain('종료 기록 없음');
  expect(html).toContain('기한 경과 기록 · 실행 중이나 실패를 의미하지 않습니다');
  expect(html).toContain('종료 정리: 미확인');
  expect(html).toContain('대사 기록 없음 · 미검증');
  expect(html).not.toContain('완료 0');
  expect(html).not.toContain('종료 기록: 시작 전 정지 또는 실패');
});
it('완료 기록이 있어도 시각 불확실 경고를 우선하고 완료 녹색을 숨긴다', () => {
  const completed = run({
    resultState: 'completed',
    verdict: 'consistent-observed-state',
    runningTicks: 60,
    checks: Object.fromEntries(paperValidationCheckNames.map((name) => [name, 'passed' as const])),
  });
  expect(render(snapshot({ runs: [completed] }))).toContain('text-teal-200');
  const html = render(snapshot({ runs: [{ ...completed, clock: 'unverified' }] }));
  expect(html).toContain('시각 불확실 · 결과 해석 주의');
  expect(html.indexOf('시각 불확실')).toBeLessThan(html.indexOf('종료 기록: 완료'));
  expect(html).not.toContain('text-teal-200');
});
it('상한과 제외 수를 실패 횟수와 구분하고 두 시장의 오류·정리 문제를 표시한다', () => {
  const html = render(
    snapshot({
      limited: true,
      rejectedCount: 3,
      runs: [
        run(),
        run({
          id: '00000000-0000-4000-8000-000000000002',
          market: 'US',
          resultState: 'review-issues-found',
          verdict: 'issues-found',
          stoppedAndCleaned: false,
          code: 'PAPER_CLEANUP_INCOMPLETE',
        }),
      ],
    }),
  );
  expect(html).toContain('제외된 기록 3개');
  expect(html).toContain('조회 상한 도달');
  expect(html).toContain('전체 목록을 보장하지 않습니다');
  expect(html).toContain('실제 실행 실패 횟수가 아닙니다');
  expect(html).toContain('대사 문제 발견');
  expect(html).toContain('종료 사유: 종료 정리 미완료');
  expect(html).toContain('종료 정리: 미완료 기록');
  expect(html).toContain('UUID와 표시 순서는 실행 시각 순서를 보장하지 않습니다');
});
it('캐시가 없으면 조회 중 상태만 표시한다', () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const html = render();
  expect(html).toContain('저장된 실행 기록을 조회하고 있습니다');
  expect(html).not.toContain('증거 묶음');
  expect(fetch).not.toHaveBeenCalled();
});
