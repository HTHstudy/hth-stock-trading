import { lazy, Suspense, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PAPER_API } from '@shared/api/paper';
import { formatMoney, formatTime } from '@shared/lib/format';
const Chart = lazy(() => import('./equity-chart').then((module) => ({ default: module.EquityChart })));
export function EquityHistory({ source }: { source: string }) {
  const [currencyIndex, setCurrencyIndex] = useState<0 | 1>(0);
  const query = useQuery({
    queryKey: ['paper-equity', source],
    queryFn: ({ signal }) => PAPER_API.equityHistory(signal),
    refetchInterval: 10000,
  });
  const data = query.isError ? undefined : query.data;
  const latest = data?.points.at(-1);
  const currency = currencyIndex === 0 ? 'KRW' : 'USD';
  return (
    <section aria-label="Paper 자산 추이" className="mt-6 rounded-2xl border border-slate-800 bg-[#0d1424] p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">Paper 자산 추이</h2>
        <div className="flex gap-3 text-xs">
          {(['KRW', 'USD'] as const).map((item, index) => (
            <button
              key={item}
              aria-pressed={currency === item}
              className={currency === item ? 'text-teal-200' : 'text-slate-500'}
              onClick={() => setCurrencyIndex(index as 0 | 1)}
            >
              {item}
            </button>
          ))}
        </div>
      </div>
      <p className="mt-3 text-xs leading-6 text-slate-400">
        {source === 'toss-readonly'
          ? '실제 시세 기반 모의 자산'
          : source === 'synthetic-only'
            ? '합성 데이터 기반 모의 자산'
            : '출처 미확인 · 조회 전용'}
        입니다. 수동 보유분을 포함한 계좌 전체 평가액이며, 통화를 합산하지 않습니다. 변동률은 최초 저장된 평가 대비로
        계산하며 전략 수익률과 다릅니다.
      </p>
      {query.isPending && (
        <p role="status" className="py-8 text-xs text-slate-500">
          자산 이력을 읽고 있습니다…
        </p>
      )}
      {query.isError && (
        <p role="alert" className="py-8 text-xs text-rose-300">
          자산 이력 조회 또는 무결성 확인에 실패했습니다.
        </p>
      )}
      {data && !data.points.length && (
        <p className="py-8 text-center text-xs text-slate-500">
          저장된 평가 이력이 없습니다. 이후 Paper 관측·체결부터 기록하며 과거 자산을 추정하지 않습니다.
        </p>
      )}
      {data?.baseline && latest && (
        <>
          <p className="mt-4 text-xs text-slate-400">
            최초 기록 {formatTime(data.baseline.recordedAt)} · 기록 대비 자산 변동률{' '}
            <span className="text-teal-200">
              {latest.changePercent[currencyIndex] === null
                ? '계산 불가 (기준 자산 0 이하)'
                : `${latest.changePercent[currencyIndex]}%`}
            </span>
          </p>
          <p className="mt-2 text-xs text-slate-500">
            최종 기록 {formatTime(latest.point.recordedAt)} · 기록 당시{' '}
            {latest.point.stale ? '평가 갱신 필요' : '평가 신선도 확인'} · 현재 시세를 나타내지 않습니다.
          </p>
          {data.points.some(({ point }) => point.stale) && (
            <p className="mt-2 text-xs text-amber-200">
              평가 갱신이 필요한 기록이 포함되어 있습니다. 그래프는 저장된 평가값을 표시합니다.
            </p>
          )}
          {data.limited && (
            <p className="mt-2 text-xs text-amber-200">
              최근 500개만 표시합니다. 변동률의 기준은 표시 구간 이전의 최초 기록입니다.
            </p>
          )}
          <Suspense fallback={<p className="py-8 text-xs text-slate-500">차트를 준비하고 있습니다…</p>}>
            <Chart points={data.points} currencyIndex={currencyIndex} />
          </Suspense>
          <div className="overflow-x-auto">
            <table className="w-full whitespace-nowrap text-left text-xs">
              <thead className="text-slate-500">
                <tr>
                  {['최근 기록(한국)', '자산 평가액', '최초 기록 대비', '기록 당시 평가'].map((label) => (
                    <th key={label} className="px-3 py-3">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.points
                  .slice(-5)
                  .reverse()
                  .map(({ point, changePercent }) => (
                    <tr key={point.version} className="border-t border-slate-800 text-slate-400">
                      <td className="px-3 py-3">{formatTime(point.recordedAt)}</td>
                      <td className="px-3 py-3">{formatMoney(point.values[currencyIndex].equity, currency)}</td>
                      <td className="px-3 py-3">
                        {changePercent[currencyIndex] === null ? '계산 불가' : `${changePercent[currencyIndex]}%`}
                      </td>
                      <td className="px-3 py-3">{point.stale ? '갱신 필요' : '신선도 확인'}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
