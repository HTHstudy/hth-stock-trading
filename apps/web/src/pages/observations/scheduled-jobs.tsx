import type { ObservationJobs } from '@hth/contracts';
import { formatTime } from '@shared/lib/format';
const labels = {
  scheduled: '예약 기록 · 시작 전',
  'awaiting-result': '시작 시각 경과 · 결과 미확인',
  failed: '중단·실패 기록',
  cancelled: '취소 기록',
  completed: '로그상 완료 · 리포트 확인 필요',
};
export function ScheduledJobs({
  result,
  reportIds,
  onSelect,
}: {
  result: ObservationJobs;
  reportIds: readonly string[];
  onSelect: (id: string) => void;
}) {
  return (
    <section aria-label="정규장 관측 예약 기록" className="mb-5 rounded-xl border border-slate-800 bg-[#0d1424] p-5">
      <h2 className="text-sm font-semibold">정규장 관측 예약 기록</h2>
      <p className="mt-3 text-xs leading-6 text-slate-400">
        예약 파일과 실행 로그를 조회합니다. 시작 전 기록만으로 프로세스가 살아 있는지 알 수 없으며, 시작 시각이 지났어도
        실행 중인지 중단됐는지 확정하지 않습니다. 완료 로그와 수집 데이터 품질 검증은 별개입니다.
      </p>
      <p className="mt-2 text-[11px] text-slate-500">
        조회 {formatTime(result.asOf)} · 예약 기록은 10초마다 다시 읽습니다. 조회로 예약·수집·거래를 시작하지 않습니다.
      </p>
      {!result.jobs.length && <p className="py-6 text-xs text-slate-500">확인할 수 있는 예약 기록이 없습니다.</p>}
      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        {result.jobs.map((job) => (
          <article key={job.id} className="rounded-lg border border-slate-800 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-sm font-medium">
                {job.instrument.market} · {job.instrument.symbol}
              </h3>
              <span
                className={`text-xs ${job.state === 'failed' ? 'text-rose-300' : job.state === 'scheduled' ? 'text-teal-200' : 'text-amber-200'}`}
              >
                {labels[job.state]}
              </span>
            </div>
            <p className="mt-3 text-xs text-slate-400">
              예정 {formatTime(job.startsAt)} · {job.requestedSamples}회 · 완료 후 {job.intervalSeconds}초 간격
            </p>
            <p className="mt-2 text-[11px] text-slate-500">{job.id}</p>
            {job.failureCode && (
              <p role="status" className="mt-3 text-xs leading-6 text-rose-300">
                {job.failureCode === 'OBSERVATION_START_MISSED'
                  ? '예정 시각을 2분 넘겨 수집 전에 중단했습니다.'
                  : '예약 실행이 중단됐습니다.'}{' '}
                <span className="block">{job.failureCode}</span>
              </p>
            )}
            {job.state === 'awaiting-result' && (
              <p className="mt-3 text-xs text-amber-200">
                종료 로그가 없습니다. 아래 관측 목록과 실행 환경을 함께 확인하세요.
              </p>
            )}
            {job.reportId &&
              (reportIds.includes(job.reportId) ? (
                <button
                  type="button"
                  className="mt-3 text-xs text-teal-200 underline underline-offset-4"
                  onClick={() => onSelect(job.reportId!)}
                >
                  저장된 리포트 선택 · 기록 {job.recordedSamples}회
                </button>
              ) : (
                <p className="mt-3 text-xs text-slate-400">
                  연결된 결과를 목록에서 확인하지 못했습니다. 상단 ‘저장 결과 새로고침’ 후 다시 확인하세요.
                </p>
              ))}
          </article>
        ))}
      </div>
      {(result.rejectedCount > 0 || result.limited) && (
        <p role="status" className="mt-4 text-xs text-amber-200">
          검증에서 제외된 예약 {result.rejectedCount}개
          {result.limited ? ' · 조회 상한으로 일부 기록만 표시합니다.' : ''}
        </p>
      )}
    </section>
  );
}
