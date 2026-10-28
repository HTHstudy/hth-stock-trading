import { lazy, Suspense, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BACKTESTS_API } from '@shared/api/backtests';
import { formatDecimal, formatMoney, profitClass } from '@shared/lib/format';
import { comparisonBlocker, sourceLabel } from './model';
import { ComparisonTable } from './comparison';
import { ReportLedger } from './ledger';

const EquityChart = lazy(() => import('./equity-chart').then((module) => ({ default: module.EquityChart })));

export function BacktestsPage() {
  const [selected, setSelected] = useState('');
  const [compared, setCompared] = useState('');
  const list = useQuery({
    queryKey: ['backtest-reports'],
    queryFn: ({ signal }) => BACKTESTS_API.list(signal),
    staleTime: 5000,
  });
  const reports = list.data?.reports ?? [];
  const primary = reports.find((item) => item.reportHash === selected) ?? reports[0];
  const comparison = reports.find((item) => item.reportHash === compared && item.reportHash !== primary?.reportHash);
  const first = useQuery({
    queryKey: ['backtest-report', primary?.reportHash],
    queryFn: ({ signal }) => BACKTESTS_API.get(primary!.reportHash, signal),
    enabled: Boolean(primary),
    staleTime: Infinity,
  });
  const second = useQuery({
    queryKey: ['backtest-report', comparison?.reportHash],
    queryFn: ({ signal }) => BACKTESTS_API.get(comparison!.reportHash, signal),
    enabled: Boolean(comparison),
    staleTime: Infinity,
  });
  const blocker = primary && comparison ? comparisonBlocker(primary, comparison) : null;
  const curves = useMemo(
    () =>
      first.data && !first.isError
        ? [first.data, ...(second.data && comparison && !second.isError && !blocker ? [second.data] : [])]
        : [],
    [first.data, first.isError, second.data, second.isError, comparison, blocker],
  );
  const metrics = first.data?.report.metrics;
  return (
    <main className="mx-auto max-w-[1600px] px-5 py-7 text-slate-200 sm:px-9 xl:ml-56 xl:px-10">
      <header className="flex flex-wrap items-center justify-between gap-5 border-b border-slate-800 pb-7">
        <div>
          <p className="text-xs tracking-wider text-slate-500">HTH TRADING / BACKTESTS</p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">백테스트 실험실</h1>
          <p className="mt-2 text-xs text-slate-400">저장한 리포트의 성과와 조건을 확인하고 두 실험을 비교합니다.</p>
        </div>
        <div className="flex items-center gap-3">
          <span className="rounded-full border border-amber-300/20 bg-amber-300/5 px-3 py-1.5 text-[11px] font-semibold text-amber-200">
            PAPER · 조회 전용
          </span>
          <button
            onClick={() => {
              void list.refetch();
              if (primary) void first.refetch();
              if (comparison) void second.refetch();
            }}
            disabled={list.isFetching}
            className="rounded-lg bg-teal-300 px-4 py-2.5 text-xs font-semibold text-slate-950 disabled:opacity-40"
          >
            {list.isFetching ? '검증 중…' : '목록 새로고침'}
          </button>
        </div>
      </header>
      <p className="my-5 rounded-xl border border-amber-300/15 bg-amber-300/5 px-5 py-4 text-xs leading-6 text-amber-100">
        합성 데모는 기능 검증용이며 실제 투자 성과가 아닙니다. 모든 결과는 합성 전량 체결·고정 비용 가정을 사용하고,
        과거 당시 정보만을 보장하지 않습니다. 이 화면에서 전략이나 주문을 실행하지 않습니다.
      </p>
      {list.isPending && (
        <p role="status" className="py-12 text-center text-sm text-slate-400">
          리포트 목록을 검증하고 있습니다…
        </p>
      )}
      {list.isError && (
        <p role="alert" className="my-6 rounded-xl border border-rose-300/20 p-5 text-sm text-rose-200">
          리포트 API에 연결할 수 없습니다. 로컬 API 서버와 리포트 디렉터리 접근 상태를 확인한 뒤 새로고침하세요.
        </p>
      )}
      {list.data && (list.data.rejectedCount > 0 || list.data.limited) && (
        <p role="status" className="mb-5 text-xs leading-6 text-amber-200">
          {list.data.rejectedCount > 0 &&
            `검증을 통과하지 못한 JSON ${list.data.rejectedCount}개를 목록에서 제외했습니다. `}
          {list.data.limited && '파일 수 또는 읽기 한도에 도달해 목록 일부만 표시합니다.'}
        </p>
      )}
      {list.data && reports.length === 0 && (
        <section className="rounded-2xl border border-dashed border-slate-700 px-6 py-14 text-center">
          <h2 className="font-medium">아직 조회할 백테스트가 없습니다.</h2>
          <p className="mt-3 text-sm text-slate-400">
            CLI에서 리포트를 프로젝트의 .local-data 디렉터리에 저장한 뒤 목록을 새로고침하세요.
          </p>
          <p className="mt-3 text-xs text-slate-500">실행 방법은 docs/BACKTESTING.md에서 확인할 수 있습니다.</p>
        </section>
      )}
      {reports.length > 0 && (
        <>
          <section aria-label="리포트 선택" className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            {[
              { label: '기준 리포트', value: primary?.reportHash ?? '', onChange: setSelected },
              { label: '비교 리포트', value: comparison?.reportHash ?? '', onChange: setCompared },
            ].map((field, index) => (
              <label key={field.label} className="rounded-xl border border-slate-800 bg-[#111a2b] p-5">
                <span className={`mb-3 block text-xs ${index ? 'text-violet-300' : 'text-teal-300'}`}>
                  {field.label}
                </span>
                <select
                  value={field.value}
                  onChange={(event) => field.onChange(event.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 p-3 text-xs text-slate-200"
                >
                  {index === 1 && <option value="">비교하지 않음</option>}
                  {reports
                    .filter((item) => index === 0 || item.reportHash !== primary?.reportHash)
                    .map((item) => (
                      <option key={item.reportHash} value={item.reportHash}>
                        {sourceLabel(item)} · {item.datasetRequest.instrument.symbol} · MA{' '}
                        {item.strategy.parameters.fastPeriod}/{item.strategy.parameters.slowPeriod} ·{' '}
                        {item.reportHash.slice(0, 8)}
                      </option>
                    ))}
                </select>
              </label>
            ))}
          </section>
          {primary && (
            <p className="mt-4 text-xs text-slate-500">
              {sourceLabel(primary)} · {primary.datasetRequest.instrument.market}{' '}
              {primary.datasetRequest.instrument.symbol} · {primary.datasetRequest.from} ~ {primary.datasetRequest.to} ·{' '}
              {primary.datasetRequest.interval} · {primary.currency}
            </p>
          )}
          {first.isPending && (
            <p role="status" className="py-12 text-center text-sm text-slate-400">
              리포트 상세를 불러오고 있습니다…
            </p>
          )}
          {(first.isError || (comparison && second.isError)) && (
            <p role="alert" className="my-5 rounded-xl border border-rose-300/20 p-5 text-sm text-rose-200">
              선택한 리포트를 읽을 수 없습니다. 파일 변경·삭제 또는 검증 실패일 수 있습니다. 목록을 새로고침하세요.
            </p>
          )}
          {metrics && first.data && !first.isError && (
            <>
              <section aria-label="기준 리포트 성과" className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                {[
                  {
                    label: '순손익',
                    value: formatMoney(metrics.netPnl, first.data.report.currency),
                    className: profitClass(metrics.netPnl),
                    note: `최종 자산 ${formatMoney(metrics.endingEquity, first.data.report.currency)}`,
                  },
                  {
                    label: '누적 수익률',
                    value: `${formatDecimal(metrics.cumulativeReturnPct, 4, true)}%`,
                    className: profitClass(metrics.netPnl),
                    note: '초기 자산 대비 · 비용 차감',
                  },
                  {
                    label: '최대 낙폭 (MDD)',
                    value: `${formatDecimal(metrics.maxDrawdownPct, 4)}%`,
                    className: 'text-slate-100',
                    note: '시가·종가 평가 지점 기준',
                  },
                  {
                    label: '승률',
                    value: metrics.winRatePct === null ? '—' : `${formatDecimal(metrics.winRatePct)}%`,
                    className: 'text-slate-100',
                    note: `완료 거래 ${metrics.tradeCount}건 · 체결 ${metrics.fillCount}건`,
                  },
                ].map((metric) => (
                  <article key={metric.label} className="rounded-2xl border border-slate-800 bg-[#111a2b] p-6">
                    <p className="text-xs text-slate-400">{metric.label}</p>
                    <p className={`mt-4 text-2xl font-semibold tracking-tight tabular-nums ${metric.className}`}>
                      {metric.value}
                    </p>
                    <p className="mt-3 text-[11px] text-slate-500">{metric.note}</p>
                  </article>
                ))}
              </section>
              <section className="mt-6 overflow-hidden rounded-2xl border border-slate-800 bg-[#111a2b]">
                <div className="border-b border-slate-800 px-6 py-5">
                  <h2 className="text-sm font-semibold">
                    누적 수익률 곡선 <span className="ml-2 text-[10px] font-normal text-slate-500">시간축 UTC</span>
                  </h2>
                  <p className="mt-2 text-xs leading-5 text-slate-500">
                    {comparison
                      ? (blocker ??
                        '같은 동결 데이터셋·통화·초기 자산 기준입니다. 전략·비용 차이는 아래 표에서 확인하세요.')
                      : '기준 리포트의 시간별 누적 수익률입니다.'}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-5 text-xs">
                    <span className="text-teal-300">
                      ━ 기준 MA {first.data.report.strategy.parameters.fastPeriod}/
                      {first.data.report.strategy.parameters.slowPeriod}
                    </span>
                    {curves.length > 1 && (
                      <span className="text-violet-300">
                        ━ 비교 MA {curves[1]!.report.strategy.parameters.fastPeriod}/
                        {curves[1]!.report.strategy.parameters.slowPeriod}
                      </span>
                    )}
                    {comparison && second.isPending && (
                      <span role="status" className="text-slate-400">
                        비교 리포트 로딩 중…
                      </span>
                    )}
                  </div>
                </div>
                <Suspense fallback={<p className="h-80 p-10 text-sm text-slate-400">차트 로딩 중…</p>}>
                  <EquityChart reports={curves} />
                </Suspense>
              </section>
              <ComparisonTable reports={[primary!, ...(comparison ? [comparison] : [])]} />
              <ReportLedger key={first.data.reportHash} artifact={first.data} />
              <details className="my-6 rounded-xl border border-slate-800 px-6 py-4 text-xs leading-6 text-slate-400">
                <summary className="cursor-pointer font-medium text-slate-300">해석할 때 확인할 가정과 한계</summary>
                <p className="mt-3">
                  신호를 알 수 있는 시각 이후의 첫 체결 가능 시가를 사용합니다. 유동성·거래 정지·실제 주문 조건을
                  재현하지 않습니다. 배당·환전·기업행위 현금 흐름은 반영하지 않으며 미청산 포지션을 강제 청산하지
                  않습니다. 검증 hash는 파일 내용의 일치를 확인하며 성과의 정확성이나 실거래 가능성을 보증하지 않습니다.
                </p>
              </details>
            </>
          )}
        </>
      )}
    </main>
  );
}
