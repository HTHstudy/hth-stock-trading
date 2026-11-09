import { useState } from 'react';
import type { StrategyResearchSnapshot } from '@hth/contracts';
import { formatDecimal, formatMoney } from '@shared/lib/format';
import { comparisonLabel, durationLabel, executionDescription, strategyLabel, strategyParametersLabel } from './model';
import type { ResearchRow } from './model';

type ResultsView = 'performance' | 'capital';

const views = [
  { id: 'performance', label: '성과' },
  { id: 'capital', label: '투자금·보유 시간' },
] as const;

export function ResearchResults({ snapshot, rows }: { snapshot: StrategyResearchSnapshot; rows: ResearchRow[] }) {
  const [view, setView] = useState<ResultsView>('performance');
  return (
    <section
      aria-label="전략 연구 결과"
      className="mt-6 overflow-hidden rounded-2xl border border-slate-800 bg-[#111a2b]"
    >
      <div className="border-b border-slate-800 p-5">
        <h2 className="text-sm font-semibold">후보와 벤치마크 · {rows.length}행</h2>
        <p className="mt-2 text-xs text-slate-400">원본 manifest 순서 · 순위나 우수 후보를 선정하지 않습니다.</p>
        <div role="group" aria-label="연구 지표 보기" className="mt-4 flex flex-wrap gap-2">
          {views.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={view === item.id}
              onClick={() => setView(item.id)}
              className={`rounded-lg border px-4 py-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-300 ${
                view === item.id
                  ? 'border-teal-300/60 bg-teal-300/10 text-teal-200'
                  : 'border-slate-600 text-slate-300 hover:bg-slate-800'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
        <p className="mt-3 text-xs leading-5 text-slate-400">
          {view === 'performance'
            ? '손익·수익률·낙폭과 체결 비용을 비교합니다. 투자 원가와 보유 기간은 ‘투자금·보유 시간’에서 확인하세요.'
            : '투자금은 취득원가 기준이며, 보유 시간은 야간·주말·휴장을 포함합니다. 성과 보기에서 수익률과 체결 비용을 확인하세요.'}
        </p>
        <p className="mt-1 text-xs text-slate-500">좁은 화면에서는 표를 좌우로 이동하세요. 전략명은 고정됩니다.</p>
      </div>
      <ResearchMetricsTable key={view} snapshot={snapshot} rows={rows} view={view} />
      {rows.length === 0 && (
        <p role="status" className="p-8 text-sm text-slate-400">
          선택한 필터에 해당하는 행이 없습니다.
        </p>
      )}
    </section>
  );
}

export function ResearchMetricsTable({
  snapshot,
  rows,
  view,
}: {
  snapshot: StrategyResearchSnapshot;
  rows: ResearchRow[];
  view: ResultsView;
}) {
  const performance = view === 'performance';
  const label = performance ? '성과' : '투자금·보유 시간';
  const columns = performance
    ? [
        '전략 / 조건',
        '초기 현금',
        '순손익',
        '수익률',
        'MDD',
        '체결 / 미체결 수',
        '수수료 / 세금',
        '벤치마크 차이 / 상태',
      ]
    : [
        '전략 / 조건',
        '순손익',
        '보유 기간 (달력)',
        '보유 비율',
        '최대 투자 원가',
        '평균 투자 원가',
        '최대 투자 원가 대비 순손익',
        '종료 수량',
      ];
  return (
    <div role="region" aria-label={`${label} 지표 가로 스크롤`} tabIndex={0} className="isolate overflow-x-auto">
      <table className="w-full min-w-[56rem] text-left text-xs tabular-nums">
        <caption className="sr-only">서버에서 계산한 전략별 {label}</caption>
        <thead className="bg-slate-900 text-slate-400">
          <tr>
            {columns.map((column, index) => (
              <th
                key={column}
                scope="col"
                className={`px-4 py-4 font-medium ${index === 0 ? 'sticky left-0 z-10 w-40 min-w-40 bg-slate-900' : ''}`}
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800">
          {rows.map((row) => {
            const dataset = snapshot.datasets.find((item) => item.id === row.dataset)!;
            const currency = dataset.request.instrument.market === 'KR' ? 'KRW' : 'USD';
            const { metrics, exposure } = row;
            const money = (value: string) => formatMoney(value, currency);
            return (
              <tr key={row.reportHash} className={row.kind === 'benchmark' ? 'bg-teal-300/5' : ''}>
                <th scope="row" className="sticky left-0 z-10 bg-[#111a2b] px-4 py-5 font-normal">
                  <span className="text-teal-200">{strategyLabel(row)}</span>
                  <span className="mt-2 block text-slate-400">
                    {strategyParametersLabel(row, snapshot.benchmark.entryAfterClosedCandles)}
                  </span>
                  <span className="mt-2 block break-words text-slate-400">
                    {dataset.request.from} ~ {dataset.request.to}
                  </span>
                  {!performance && <span className="mt-2 block text-amber-200">{comparisonLabel(row)}</span>}
                  <details className="mt-2 text-slate-400">
                    <summary className="cursor-pointer">체결 비용 가정</summary>
                    <p className="mt-2 break-all leading-6">
                      데이터셋 ID: {row.dataset} · 조건 ID: {row.variant}
                    </p>
                    <p className="mt-2 break-words leading-6">{executionDescription(row)}</p>
                    {row.execution.executionRules && (
                      <pre className="mt-2 max-w-48 overflow-x-auto">
                        {JSON.stringify(row.execution.executionRules, null, 2)}
                      </pre>
                    )}
                  </details>
                </th>
                {performance ? (
                  <>
                    <td className="whitespace-nowrap px-4 py-5">{money(metrics.initialCash)}</td>
                    <td className="whitespace-nowrap px-4 py-5">{money(metrics.netPnl)}</td>
                    <td className="whitespace-nowrap px-4 py-5">{formatDecimal(metrics.cumulativeReturnPct, 4)}%</td>
                    <td className="whitespace-nowrap px-4 py-5">{formatDecimal(metrics.maxDrawdownPct, 4)}%</td>
                    <td className="whitespace-nowrap px-4 py-5">
                      {metrics.fillCount} / {row.unfilledAtEnd}
                    </td>
                    <td className="whitespace-nowrap px-4 py-5">
                      {money(metrics.totalFees)} / {money(metrics.totalTax)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-5">
                      <span>{comparisonLabel(row)}</span>
                      {row.comparisonStatus === 'compared' && row.netPnlDifference !== null && (
                        <span className="mt-2 block">{money(row.netPnlDifference)}</span>
                      )}
                    </td>
                  </>
                ) : (
                  <>
                    <td className="whitespace-nowrap px-4 py-5">{money(metrics.netPnl)}</td>
                    <td className="whitespace-nowrap px-4 py-5">{durationLabel(exposure.holdingMilliseconds)}</td>
                    <td className="whitespace-nowrap px-4 py-5">{formatDecimal(exposure.holdingPct, 4)}%</td>
                    <td className="whitespace-nowrap px-4 py-5">{money(exposure.maxInvestedCapital)}</td>
                    <td className="whitespace-nowrap px-4 py-5">{money(exposure.averageInvestedCapital)}</td>
                    <td className="whitespace-nowrap px-4 py-5">
                      {exposure.netPnlOverMaxInvestedCapitalPct === null
                        ? exposure.windowMilliseconds === 0
                          ? '측정 구간 없음'
                          : '투자 없음'
                        : `${formatDecimal(exposure.netPnlOverMaxInvestedCapitalPct, 4)}%`}
                    </td>
                    <td className="whitespace-nowrap px-4 py-5">{formatDecimal(metrics.endingQuantity, 4)}</td>
                  </>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
