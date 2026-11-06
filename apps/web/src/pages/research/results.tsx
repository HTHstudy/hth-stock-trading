import type { StrategyResearchSnapshot } from '@hth/contracts';
import { formatDecimal, formatMoney } from '@shared/lib/format';
import { comparisonLabel, durationLabel, executionDescription, strategyLabel, strategyParametersLabel } from './model';
import type { ResearchRow } from './model';

export function ResearchResults({ snapshot, rows }: { snapshot: StrategyResearchSnapshot; rows: ResearchRow[] }) {
  return (
    <section
      aria-label="전략 연구 결과"
      className="mt-6 overflow-hidden rounded-2xl border border-slate-800 bg-[#111a2b]"
    >
      <div className="border-b border-slate-800 p-5">
        <h2 className="text-sm font-semibold">후보와 벤치마크 · {rows.length}행</h2>
        <p className="mt-2 text-xs text-slate-400">
          원본 manifest 순서 · 순위나 우수 후보를 선정하지 않습니다. 가로로 스크롤해 모든 지표를 확인하세요.
        </p>
      </div>
      <div role="region" aria-label="연구 지표 가로 스크롤" tabIndex={0} className="overflow-x-auto">
        <table className="w-full whitespace-nowrap text-left text-xs tabular-nums">
          <caption className="sr-only">서버에서 계산한 전략별 성과와 자본 노출</caption>
          <thead className="bg-slate-900/60 text-slate-400">
            <tr>
              {[
                '전략 / 파라미터',
                '데이터셋 / 비용',
                '초기 현금',
                '순손익',
                '수익률',
                'MDD',
                '체결 수',
                '수수료 / 세금',
                '종료 수량',
                '미체결 수',
                '보유 기간 (달력)',
                '보유 비율',
                '최대 투자 원가',
                '평균 투자 원가',
                '최대 투자 원가 대비 순손익',
                '벤치마크 차이 / 상태',
              ].map((label) => (
                <th key={label} scope="col" className="px-4 py-4 font-medium">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {rows.map((row) => {
              const currency =
                snapshot.datasets.find((dataset) => dataset.id === row.dataset)!.request.instrument.market === 'KR'
                  ? 'KRW'
                  : 'USD';
              const { metrics, exposure } = row;
              const money = (value: string) => formatMoney(value, currency);
              return (
                <tr key={row.reportHash} className={row.kind === 'benchmark' ? 'bg-teal-300/5' : ''}>
                  <th scope="row" className="px-4 py-5 font-normal">
                    <span className="text-teal-200">{strategyLabel(row)}</span>
                    <span className="mt-2 block text-slate-400">
                      {strategyParametersLabel(row, snapshot.benchmark.entryAfterClosedCandles)}
                    </span>
                    <span className="mt-1 block text-slate-500">{row.variant}</span>
                  </th>
                  <td className="px-4 py-5">
                    <span>{row.dataset}</span>
                    <details className="mt-2 max-w-72 whitespace-normal text-slate-400">
                      <summary className="cursor-pointer">체결 비용 가정</summary>
                      <p className="mt-2 leading-6">{executionDescription(row)}</p>
                    </details>
                  </td>
                  <td className="px-4 py-5">{money(metrics.initialCash)}</td>
                  <td className="px-4 py-5">{money(metrics.netPnl)}</td>
                  <td className="px-4 py-5">{formatDecimal(metrics.cumulativeReturnPct, 4)}%</td>
                  <td className="px-4 py-5">{formatDecimal(metrics.maxDrawdownPct, 4)}%</td>
                  <td className="px-4 py-5">{metrics.fillCount}</td>
                  <td className="px-4 py-5">
                    {money(metrics.totalFees)} / {money(metrics.totalTax)}
                  </td>
                  <td className="px-4 py-5">{formatDecimal(metrics.endingQuantity, 4)}</td>
                  <td className="px-4 py-5">{row.unfilledAtEnd}</td>
                  <td className="px-4 py-5">{durationLabel(exposure.holdingMilliseconds)}</td>
                  <td className="px-4 py-5">{formatDecimal(exposure.holdingPct, 4)}%</td>
                  <td className="px-4 py-5">{money(exposure.maxInvestedCapital)}</td>
                  <td className="px-4 py-5">{money(exposure.averageInvestedCapital)}</td>
                  <td className="px-4 py-5">
                    {exposure.netPnlOverMaxInvestedCapitalPct === null
                      ? exposure.windowMilliseconds === 0
                        ? '측정 구간 없음'
                        : '투자 없음'
                      : `${formatDecimal(exposure.netPnlOverMaxInvestedCapitalPct, 4)}%`}
                  </td>
                  <td className="px-4 py-5">
                    <span>{comparisonLabel(row)}</span>
                    {row.comparisonStatus === 'compared' && row.netPnlDifference !== null && (
                      <span className="mt-2 block">{money(row.netPnlDifference)}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && (
        <p role="status" className="p-8 text-sm text-slate-400">
          선택한 필터에 해당하는 행이 없습니다.
        </p>
      )}
    </section>
  );
}
