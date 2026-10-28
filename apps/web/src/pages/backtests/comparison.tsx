import type { BacktestSummary } from '@shared/api/backtests';
import { formatDecimal, formatMoney } from '@shared/lib/format';
import { sourceLabel } from './model';

export function ComparisonTable({ reports }: { reports: BacktestSummary[] }) {
  const rows: { label: string; value: (report: BacktestSummary) => string }[] = [
    { label: '입력 출처', value: sourceLabel },
    {
      label: '시장 · 종목',
      value: (item) => `${item.datasetRequest.instrument.market} · ${item.datasetRequest.instrument.symbol}`,
    },
    {
      label: '기간 · 봉',
      value: (item) => `${item.datasetRequest.from} ~ ${item.datasetRequest.to} · ${item.datasetRequest.interval}`,
    },
    {
      label: '이동평균 기간',
      value: (item) => `${item.strategy.parameters.fastPeriod} / ${item.strategy.parameters.slowPeriod}`,
    },
    { label: '초기 자산', value: (item) => formatMoney(item.config.initialCash, item.currency) },
    {
      label: '매수 수량 · 호가 가정',
      value: (item) => `${item.config.quantity}주 · ${item.config.priceTick} ${item.currency}`,
    },
    { label: '매수/매도 수수료', value: (item) => `${item.config.buyFeeBps} / ${item.config.sellFeeBps} bps` },
    { label: '매도세 · 슬리피지', value: (item) => `${item.config.sellTaxBps} / ${item.config.slippageBps} bps` },
    { label: '수정주가', value: (item) => (item.datasetRequest.adjusted ? '적용' : '미적용') },
    { label: '최종 자산', value: (item) => formatMoney(item.metrics.endingEquity, item.currency) },
    { label: '누적 수익률', value: (item) => `${formatDecimal(item.metrics.cumulativeReturnPct, 4, true)}%` },
    { label: '최대 낙폭 (MDD)', value: (item) => `${formatDecimal(item.metrics.maxDrawdownPct, 4)}%` },
    {
      label: '실현 / 미실현 손익',
      value: (item) =>
        `${formatMoney(item.metrics.realizedPnl, item.currency)} / ${formatMoney(item.metrics.unrealizedPnl, item.currency)}`,
    },
    {
      label: '승률',
      value: (item) =>
        item.metrics.winRatePct === null ? '— (청산 거래 없음)' : `${formatDecimal(item.metrics.winRatePct)}%`,
    },
    { label: '완료 거래 / 체결 수', value: (item) => `${item.metrics.tradeCount} / ${item.metrics.fillCount}` },
    {
      label: '총 수수료 / 세금',
      value: (item) =>
        `${formatMoney(item.metrics.totalFees, item.currency)} / ${formatMoney(item.metrics.totalTax, item.currency)}`,
    },
    { label: '종료 보유 수량', value: (item) => `${item.metrics.endingQuantity}주` },
    { label: '전략 버전', value: (item) => `${item.strategy.id}@${item.strategy.version}` },
    { label: '데이터셋 SHA-256', value: (item) => item.dataset.contentHash },
    { label: '리포트 SHA-256', value: (item) => item.reportHash },
  ];
  return (
    <section className="mt-6 overflow-hidden rounded-2xl border border-slate-800 bg-[#111a2b]">
      <h2 className="border-b border-slate-800 px-6 py-5 text-sm font-semibold">실험 조건 · 성과 비교</h2>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[600px] table-fixed text-left text-xs">
          <thead>
            <tr className="border-b border-slate-800 text-slate-500">
              <th className="w-40 px-6 py-4 font-normal">항목</th>
              {reports.map((item, index) => (
                <th
                  key={item.reportHash}
                  className={`px-6 py-4 font-medium ${index ? 'text-violet-300' : 'text-teal-300'}`}
                >
                  {index ? '비교' : '기준'} · {item.reportHash.slice(0, 8)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label} className="border-b border-slate-800/50 last:border-0">
                <th scope="row" className="px-6 py-3 font-normal text-slate-500">
                  {row.label}
                </th>
                {reports.map((item) => (
                  <td
                    key={item.reportHash}
                    className="break-words px-6 py-3 font-mono text-[11px] leading-5 tabular-nums"
                  >
                    {row.value(item)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
