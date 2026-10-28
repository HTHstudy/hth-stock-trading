import { useState } from 'react';
import type { BacktestArtifact } from '@shared/api/backtests';
import { formatDecimal, formatMoney, formatTime, profitClass } from '@shared/lib/format';
import { signalStatuses } from './model';

export function ReportLedger({ artifact }: { artifact: BacktestArtifact }) {
  const [tab, setTab] = useState<'fills' | 'trades' | 'signals'>('fills');
  const [page, setPage] = useState(0);
  const { report } = artifact;
  const size = report[tab].length;
  const start = page * 50;
  const header =
    tab === 'fills'
      ? ['시각 (한국 시간)', '방향', '체결 가격', '수량', '수수료', '매도세', '잔여 현금']
      : tab === 'trades'
        ? ['매수 시각', '매도 시각', '순손익']
        : ['평가 시각 (한국 시간)', '신호', '이유', '결과'];
  return (
    <section className="mt-6 overflow-hidden rounded-2xl border border-slate-800 bg-[#111a2b]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-6 py-5">
        <h2 className="text-sm font-semibold">기준 리포트 내역</h2>
        <div className="flex gap-2">
          {(['fills', 'trades', 'signals'] as const).map((key) => (
            <button
              key={key}
              aria-pressed={tab === key}
              onClick={() => {
                setTab(key);
                setPage(0);
              }}
              className={`rounded-lg px-3 py-2 text-xs ${tab === key ? 'bg-teal-300/10 text-teal-200' : 'text-slate-400 hover:bg-slate-800'}`}
            >
              {key === 'fills' ? '체결' : key === 'trades' ? '왕복 거래' : '신호'} {report[key].length}
            </button>
          ))}
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[650px] text-left text-xs">
          <thead className="border-b border-slate-800 text-slate-500">
            <tr>
              {header.map((title) => (
                <th key={title} className="px-5 py-4 font-normal">
                  {title}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {tab === 'fills' &&
              report.fills.slice(start, start + 50).map((fill, index) => (
                <tr key={start + index} className="border-b border-slate-800/50">
                  <td className="px-5 py-4">{formatTime(fill.timestamp)}</td>
                  <td className={fill.action === 'BUY' ? 'text-rose-300' : 'text-sky-300'}>
                    {fill.action === 'BUY' ? '매수' : '매도'}
                  </td>
                  <td className="px-5 py-4">{formatMoney(fill.price, report.currency)}</td>
                  <td className="px-5 py-4">{formatDecimal(fill.quantity, 0)}</td>
                  <td className="px-5 py-4">{formatMoney(fill.fee, report.currency)}</td>
                  <td className="px-5 py-4">{formatMoney(fill.tax, report.currency)}</td>
                  <td className="px-5 py-4">{formatMoney(fill.cashAfter, report.currency)}</td>
                </tr>
              ))}
            {tab === 'trades' &&
              report.trades.slice(start, start + 50).map((trade, index) => (
                <tr key={start + index} className="border-b border-slate-800/50">
                  <td className="px-5 py-4">{formatTime(report.fills[trade.entryFill]?.timestamp)}</td>
                  <td className="px-5 py-4">{formatTime(report.fills[trade.exitFill]?.timestamp)}</td>
                  <td className={`px-5 py-4 ${profitClass(trade.netPnl)}`}>
                    {formatMoney(trade.netPnl, report.currency)}
                  </td>
                </tr>
              ))}
            {tab === 'signals' &&
              report.signals.slice(start, start + 50).map((signal, index) => (
                <tr key={start + index} className="border-b border-slate-800/50">
                  <td className="px-5 py-4">{formatTime(signal.evaluatedAt)}</td>
                  <td className="px-5 py-4">{signal.action}</td>
                  <td className="px-5 py-4">{signal.reason}</td>
                  <td className="px-5 py-4">{signalStatuses[signal.status]}</td>
                </tr>
              ))}
          </tbody>
        </table>
        {size === 0 && (
          <p className="p-10 text-center text-sm text-slate-500">
            {tab === 'trades'
              ? '청산 완료한 왕복 거래가 없습니다. 미청산 포지션은 포함하지 않습니다.'
              : '기록된 내역이 없습니다.'}
          </p>
        )}
      </div>
      {size > 0 && (
        <div className="flex items-center justify-end gap-4 px-6 py-4 text-xs text-slate-400">
          <span>
            {start + 1}–{Math.min(start + 50, size)} / {size}
          </span>
          <button
            disabled={page === 0}
            onClick={() => setPage(page - 1)}
            className="rounded border border-slate-700 px-3 py-2 disabled:opacity-30"
          >
            이전
          </button>
          <button
            disabled={start + 50 >= size}
            onClick={() => setPage(page + 1)}
            className="rounded border border-slate-700 px-3 py-2 disabled:opacity-30"
          >
            다음
          </button>
        </div>
      )}
    </section>
  );
}
