import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { OBSERVATIONS_API } from '@shared/api/observations';
import { formatTime } from '@shared/lib/format';

const states = { completed: '관측 종료', failed: '중단·실패', cancelled: '취소', incomplete: '진행 중 또는 미완료' };
const sourceLabel = (source: 'toss-readonly' | 'synthetic-only') =>
  source === 'toss-readonly' ? '실제 시세' : '합성 데이터';
const number = (value: number | undefined | null) =>
  value == null ? '—' : new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 1 }).format(value);
const panel = 'rounded-xl border border-slate-800 bg-[#0d1424] p-5';
export function ObservationsPage() {
  const [selected, setSelected] = useState('');
  const list = useQuery({
    queryKey: ['observation-reports'],
    queryFn: ({ signal }) => OBSERVATIONS_API.list(signal),
    staleTime: 5000,
  });
  const reports = list.data?.reports ?? [];
  const primary = reports.find((item) => item.manifest.id === selected) ?? reports[0];
  const detail = useQuery({
    queryKey: ['observation-report', primary?.manifest.id],
    queryFn: ({ signal }) => OBSERVATIONS_API.get(primary!.manifest.id, signal),
    enabled: Boolean(primary),
    staleTime: 5000,
  });
  const report = detail.isError ? undefined : detail.data;
  const summary = report?.summary;
  const cards: readonly (readonly [string, number])[] = summary
    ? [
        ['수집 오류', summary.errorSamples],
        ['정상 종목 관측', summary.healthy],
        ['휴장·정규장 밖', summary.closed],
        ['차단 종목 관측', summary.blocked],
      ]
    : [];
  const reasonPanels: readonly (readonly [string, Record<string, number | undefined>])[] = summary
    ? [
        ['데이터 차단 사유', summary.blockers],
        ['수집 오류 코드', summary.errors],
      ]
    : [];
  return (
    <main className="mx-auto max-w-[1600px] px-5 py-7 text-slate-200 sm:px-9 xl:ml-56 xl:px-10">
      <header className="flex flex-wrap items-center justify-between gap-5 border-b border-slate-800 pb-7">
        <div>
          <p className="text-xs tracking-wider text-slate-500">HTH TRADING / OBSERVATIONS</p>
          <h1 className="mt-2 text-2xl font-semibold">시세 관측 리포트</h1>
          <p className="mt-2 text-xs text-slate-400">저장된 수집 상태와 데이터 품질을 확인합니다.</p>
        </div>
        <button
          className="rounded-lg bg-teal-300 px-4 py-2.5 text-xs font-semibold text-slate-950 disabled:opacity-40"
          disabled={list.isFetching || detail.isFetching}
          onClick={() => {
            void list.refetch();
            if (primary) void detail.refetch();
          }}
        >
          저장 결과 새로고침
        </button>
      </header>
      <p className="my-5 rounded-xl border border-amber-300/20 bg-amber-300/5 px-5 py-4 text-xs leading-6 text-amber-100">
        시장 데이터만 검사한 기록입니다. 관측 종료는 전략·계좌·리스크 검증이나 매매 승인이 아닙니다. 이 화면에서 시세
        수집이나 거래를 시작하지 않습니다.
      </p>
      {list.isError && (
        <p role="alert" className="mb-5 text-sm text-rose-300">
          목록을 조회하지 못했습니다. 표시 중인 목록은 마지막 수신값일 수 있습니다.
        </p>
      )}
      {list.isPending && (
        <p role="status" className="py-16 text-center text-slate-400">
          저장된 리포트를 확인하고 있습니다…
        </p>
      )}
      {!list.isPending && !list.isError && reports.length === 0 && (
        <section className={`${panel} py-16 text-center`}>
          <h2>아직 저장된 관측 리포트가 없습니다</h2>
          <p className="mt-3 text-sm text-slate-400">관측 실행 결과가 저장되면 이곳에서 확인할 수 있습니다.</p>
        </section>
      )}
      {Boolean(list.data?.rejectedCount || list.data?.limited) && (
        <p role="status" className="mb-5 text-xs text-amber-200">
          검증에서 제외된 항목 {list.data?.rejectedCount ?? 0}개
          {list.data?.limited ? ' · 조회 상한에 도달하여 일부 항목만 표시합니다.' : ''}
        </p>
      )}
      {primary && (
        <label className="mb-5 block text-xs text-slate-400">
          관측 실행 선택
          <select
            aria-label="관측 실행 선택"
            value={primary.manifest.id}
            onChange={(event) => setSelected(event.target.value)}
            className="mt-2 block w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-3 text-sm text-slate-200"
          >
            {reports.map((item) => (
              <option key={item.manifest.id} value={item.manifest.id}>
                {formatTime(item.manifest.startedAt)} · {sourceLabel(item.manifest.source)} · {states[item.state]} ·{' '}
                {item.manifest.id.slice(0, 8)}
              </option>
            ))}
          </select>
        </label>
      )}
      {primary && detail.isPending && (
        <p role="status" className="py-12 text-center text-slate-400">
          관측 기록의 해시와 합계를 검증하고 있습니다…
        </p>
      )}
      {detail.isError && (
        <p role="alert" className="mb-5 rounded-xl border border-rose-400/20 p-5 text-sm text-rose-200">
          리포트가 변경·삭제되었거나 검증에 실패했습니다. 저장 결과를 새로고침해 주세요.
        </p>
      )}
      {report && (
        <>
          <section className="mb-5 grid gap-4 md:grid-cols-3">
            <div className={panel}>
              <p className="text-xs text-slate-500">출처</p>
              <p className="mt-3 font-semibold text-teal-200">{sourceLabel(report.manifest.source)}</p>
              <p className="mt-2 text-xs text-slate-400">
                {report.manifest.instruments.map((item) => `${item.market}:${item.symbol}`).join(' · ')}
              </p>
            </div>
            <div className={panel}>
              <p className="text-xs text-slate-500">실행 상태</p>
              <p className="mt-3 font-semibold">{states[report.state]}</p>
              <p className="mt-2 text-xs text-slate-400">
                {formatTime(report.manifest.startedAt)} →{' '}
                {report.finishedAt ? formatTime(report.finishedAt) : '종료 시각 미확인'}
              </p>
            </div>
            <div className={panel}>
              <p className="text-xs text-slate-500">저장 무결성</p>
              <p className="mt-3 font-semibold">{report.journalSha256 ? '기록 해시·형식 검증' : '최종 기록 미확인'}</p>
              <p className="mt-2 text-xs text-slate-400">
                {report.journalSha256
                  ? `기록 ${report.recordedSamples}/${report.manifest.samples}회`
                  : '실행 중이거나 정상 종료되지 않았을 수 있습니다.'}
              </p>
            </div>
          </section>
          {report.failureCode && (
            <p role="alert" className="mb-5 rounded-xl border border-rose-400/20 p-5 text-sm text-rose-200">
              수집 실행이 중단됐습니다: {report.failureCode}. 완료 요약은 없습니다.
            </p>
          )}
          {summary && (
            <>
              <section className="mb-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {cards.map(([label, value]) => (
                  <div key={label} className={panel}>
                    <p className="text-xs text-slate-500">{label}</p>
                    <p className="mt-3 text-2xl font-semibold">{number(value)}</p>
                  </div>
                ))}
              </section>
              <section className={`${panel} mb-5 overflow-x-auto`}>
                <h2 className="mb-4 text-sm font-semibold">종목별 데이터 품질</h2>
                <table className="w-full whitespace-nowrap text-left text-xs">
                  <thead className="text-slate-500">
                    <tr>
                      {['종목', '관측', '정상', '정규장 밖', '차단', '시각 퇴행', '시각 누락', '최대 지연(ms)'].map(
                        (label) => (
                          <th key={label} className="px-3 py-3">
                            {label}
                          </th>
                        ),
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(summary.instruments).map(([symbol, item]) => (
                      <tr key={symbol} className="border-t border-slate-800">
                        <td className="px-3 py-3 text-teal-200">{symbol}</td>
                        {[
                          item.samples,
                          item.healthy,
                          item.closed,
                          item.blocked,
                          item.quoteRegressions,
                          item.missingQuoteTimes,
                          item.maxQuoteAgeMs,
                        ].map((value, index) => (
                          <td key={index} className="px-3 py-3">
                            {number(value)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-3 text-xs text-slate-500">
                  휴장 중 오래된 시세도 지연과 차단 사유를 보존합니다. 시장 상황과 함께 검토해 주세요.
                </p>
              </section>
              <section className="mb-5 grid gap-4 md:grid-cols-2">
                {reasonPanels.map(([title, values]) => (
                  <div key={title} className={panel}>
                    <h2 className="mb-3 text-sm font-semibold">{title}</h2>
                    {Object.entries(values).length ? (
                      Object.entries(values).map(([code, count]) => (
                        <p key={code} className="flex justify-between gap-3 py-1 text-xs text-slate-400">
                          <span>{code}</span>
                          <span>{number(count)}</span>
                        </p>
                      ))
                    ) : (
                      <p className="text-xs text-slate-500">기록 없음</p>
                    )}
                  </div>
                ))}
              </section>
            </>
          )}
          {report.journalSha256 && (
            <section className={`${panel} overflow-x-auto`}>
              <h2 className="mb-4 text-sm font-semibold">최근 관측 기록</h2>
              <table className="w-full whitespace-nowrap text-left text-xs">
                <thead className="text-slate-500">
                  <tr>
                    {['순서', '관측 종료', '수집 시간(ms)', '수집 오류', '종목 상태'].map((label) => (
                      <th key={label} className="px-3 py-3">
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {report.recentSamples.map((sample) => (
                    <tr key={sample.index} className="border-t border-slate-800">
                      <td className="px-3 py-3">{sample.index}</td>
                      <td className="px-3 py-3">{formatTime(sample.finishedAt)}</td>
                      <td className="px-3 py-3">{number(sample.durationMs)}</td>
                      <td className="px-3 py-3">{sample.error ?? '없음'}</td>
                      <td className="px-3 py-3">
                        {sample.instruments
                          .map(
                            (item) =>
                              `${item.instrument.market}:${item.instrument.symbol} · ${item.state === 'healthy' ? '정상' : item.state === 'closed' ? '정규장 밖' : '차단'}`,
                          )
                          .join(' / ')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {report.samplesLimited && (
                <p className="mt-3 text-xs text-slate-500">최근 50회만 표시합니다. 합계는 전체 기록 기준입니다.</p>
              )}
            </section>
          )}
        </>
      )}
    </main>
  );
}
