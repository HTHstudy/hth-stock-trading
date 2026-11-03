import { useEffect, useReducer } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { PaperValidationRun } from '@hth/contracts';
import { PAPER_API } from '@shared/api/paper';
import { formatTime } from '@shared/lib/format';
import {
  validationCheckLabels,
  validationCodeLabels,
  validationEvidenceLabels,
  validationResultLabels,
  validationRunPresentation,
  validationVerdictLabels,
} from './validation-runs-model';

function ValidationRun({ run }: { run: PaperValidationRun }) {
  const presentation = validationRunPresentation(run);
  return (
    <article className="mt-3 rounded-xl border border-slate-700/70 p-4 text-xs leading-6">
      <details>
        <summary
          className={`cursor-pointer font-semibold ${presentation.className} focus-visible:outline-2 focus-visible:outline-teal-300`}
        >
          {presentation.label} ·{' '}
          {run.finishedAt
            ? formatTime(run.finishedAt)
            : run.startsAt
              ? formatTime(run.startsAt) + ' 시작 예정'
              : '시각 미기록'}
        </summary>
        {run.clock === 'unverified' && (
          <p role="alert" className="text-amber-100">
            기록 시각 또는 시간 순서를 검증하지 못했습니다. 완료 기록도 검증 완료로 해석하지 않습니다.
          </p>
        )}
        {run.clock === 'unverified' && run.resultState && <p>{validationResultLabels[run.resultState]}</p>}
        <p className="break-all text-slate-500">증거 묶음 {run.id}</p>
        <p>
          시작 예정 {run.startsAt ? formatTime(run.startsAt) : '기록 없음'} · 기한 {formatTime(run.deadline)}
        </p>
        {run.finishedAt && <p>종료 기록 시각 {formatTime(run.finishedAt)}</p>}
        {run.deadlineElapsed && (
          <p className="text-amber-100">기한 경과 기록 · 실행 중이나 실패를 의미하지 않습니다.</p>
        )}
        {run.state === 'awaiting-result' && <p>요청만으로 프로세스 생존·실행 중·실패 여부를 추정하지 않습니다.</p>}
        <p>
          저장된 tick · 완료 {run.completedTicks ?? '기록 없음'} · 실행 상태 보고 {run.runningTicks ?? '기록 없음'}
        </p>
        <p className="text-slate-400">tick은 종료 파일의 보고값이며 연속 실행의 독립 증명이 아닙니다.</p>
        <p>
          종료 정리:{' '}
          {run.stoppedAndCleaned === null ? '미확인' : run.stoppedAndCleaned ? '정지·정리 기록 있음' : '미완료 기록'}
        </p>
        <p>증거 수준: {validationEvidenceLabels[run.evidence]}</p>
        <p className={run.verdict === 'consistent-observed-state' ? 'text-slate-300' : 'text-amber-100'}>
          {run.verdict ? validationVerdictLabels[run.verdict] : '대사 기록 없음 · 미검증'}
        </p>
        {run.code && <p className="text-amber-100">종료 사유: {validationCodeLabels[run.code]}</p>}
        {run.observedCounts && (
          <p>
            저장된 대사 집계 · 새 주문 의도 {run.observedCounts.newIntents} · 모의 체결 {run.observedCounts.newFills} ·
            관측 {run.observedCounts.newObservations} · 진단 {run.observedCounts.newDiagnostics} · 소유권 획득{' '}
            {run.observedCounts.leaseAcquisitions} · 해제 {run.observedCounts.leaseReleases}
          </p>
        )}
        <details className="mt-2 text-slate-400">
          <summary className="cursor-pointer">저장된 검증 체크</summary>
          <ul>
            {Object.entries(validationCheckLabels).map(([key, label]) => {
              const check = run.checks?.[key as keyof typeof validationCheckLabels];
              return (
                <li key={key}>
                  {label}: {check === 'passed' ? '통과' : check === 'failed' ? '문제 발견' : '미검증'}
                </li>
              );
            })}
          </ul>
        </details>
      </details>
    </article>
  );
}

export function ValidationRunsPanel() {
  const query = useQuery({
    queryKey: ['paper-validation-runs'],
    queryFn: ({ signal }) => PAPER_API.validationRuns(signal),
    refetchInterval: 10000,
    refetchOnWindowFocus: true,
    retry: false,
  });
  const [, refreshExpiry] = useReducer((value: number) => value + 1, 0);
  useEffect(() => {
    if (!query.dataUpdatedAt) return;
    const timeout = setTimeout(refreshExpiry, Math.max(0, query.dataUpdatedAt + 30000 - Date.now()));
    return () => clearTimeout(timeout);
  }, [query.dataUpdatedAt]);
  const expired = Boolean(query.data && Date.now() - query.dataUpdatedAt >= 30000);
  const state = query.isError || expired ? undefined : query.data;
  return (
    <section className="my-6 rounded-xl border border-slate-800 bg-[#0d1424] p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold">저장된 Paper 실행 기록</h2>
        <button
          type="button"
          disabled={query.isFetching}
          onClick={() => {
            void query.refetch();
          }}
          className="rounded-lg border border-slate-700 px-3 py-2 text-xs disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-teal-300"
        >
          {query.isFetching ? '조회 중…' : '실행 기록 새로고침'}
        </button>
      </div>
      <p className="mt-2 text-xs leading-6 text-slate-400">
        상단 연결 원장과 별도인 국내·미국 실행의 저장 기록입니다. 종료 기록이 없으면 현재 실행 여부는 미확인입니다. 대사
        결과는 저장된 판단이며 조회에서 다시 계산하지 않습니다.
      </p>
      {query.isPending && (
        <p role="status" className="mt-4 text-xs">
          저장된 실행 기록을 조회하고 있습니다…
        </p>
      )}
      {(query.isError || expired) && (
        <p role="alert" className="mt-4 text-xs text-amber-100">
          {expired ? '조회 캐시가 30초 만료됐습니다.' : '실행 기록 조회에 실패했습니다.'} 이전 정상 결과를 숨겼습니다.
        </p>
      )}
      {state && (
        <>
          <p className="mt-3 text-xs text-slate-400">
            조회 시각 {formatTime(state.asOf)} · 제외된 기록 {state.rejectedCount}개 · 조회 상한{' '}
            {state.limited ? '도달' : '미도달'}
          </p>
          {state.rejectedCount > 0 && (
            <p role="alert" className="mt-2 text-xs text-amber-100">
              자료 누락·검증 거부로 제외된 수이며 실제 실행 실패 횟수가 아닙니다.
            </p>
          )}
          {state.limited && (
            <p role="alert" className="mt-2 text-xs text-amber-100">
              스캔·결과·읽기 예산 상한으로 일부 기록이 생략될 수 있습니다. 전체 목록을 보장하지 않습니다.
            </p>
          )}
          {state.availability === 'not-recorded' && <p className="mt-4 text-xs">저장된 실행 기록이 없습니다.</p>}
          {state.availability === 'unavailable' && (
            <p role="alert" className="mt-4 text-xs text-amber-100">
              저장 자료에 접근하거나 형식을 검증할 수 없습니다. 기록 없음과 다릅니다.
            </p>
          )}
          {state.availability === 'available' && (
            <>
              <p className="mt-2 text-xs text-slate-400">
                시장별 서버 반환 순서입니다. UUID와 표시 순서는 실행 시각 순서를 보장하지 않습니다.
              </p>
              <div className="mt-4 grid gap-4 lg:grid-cols-2">
                {(['KR', 'US'] as const).map((market) => {
                  const runs = state.runs.filter((run) => run.market === market);
                  return (
                    <section key={market}>
                      <h3 className="text-sm font-semibold">{market === 'KR' ? '국내 (KR)' : '미국 (US)'}</h3>
                      {runs.length ? (
                        runs.map((run) => <ValidationRun key={run.id} run={run} />)
                      ) : (
                        <p className="mt-3 text-xs text-slate-400">표시할 기록 없음</p>
                      )}
                    </section>
                  );
                })}
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
