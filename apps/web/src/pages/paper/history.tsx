import type { PaperDashboardSnapshot } from '@shared/api/paper';
import { formatDecimal, formatMoney, formatTime, profitClass } from '@shared/lib/format';
import { codeLabel, eventLabel, isFailure, orderLabels } from './model';

export type HistoryTab = 'orders' | 'fills' | 'events';
export function PaperHistory({ snapshot, tab }: { snapshot: PaperDashboardSnapshot; tab: HistoryTab }) {
  const headings =
    tab === 'orders'
      ? ['기록 시각', '종목 / 전략', '방향', '주문 / 체결 수량', '지정가', '상태']
      : tab === 'fills'
        ? ['체결 시각', '종목', '방향', '수량', '체결가', '비용', '실현 손익']
        : ['기록 시각', '이벤트', '상세'];
  const limited = snapshot.history[`${tab}Limited`];
  const items = snapshot[tab];
  return (
    <>
      <p className="px-5 py-3 text-xs text-slate-500">
        최근 {items.length}개 · 최신순{limited ? ' · 이전 이력은 이 화면에 포함되지 않습니다.' : ''}
        {tab === 'events' ? ' · 반복 평가 갱신 이벤트 제외' : ''}
      </p>
      {items.length === 0 ? (
        <p className="px-5 py-12 text-center text-sm text-slate-500">
          아직 기록된 {tab === 'orders' ? '주문' : tab === 'fills' ? '체결' : '이벤트'}이 없습니다.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full whitespace-nowrap text-left text-xs">
            <caption className="sr-only">
              {tab === 'orders' ? '모의 주문 이력' : tab === 'fills' ? '모의 체결 이력' : '원장 이벤트와 실패 이력'}
            </caption>
            <thead className="border-y border-slate-800 text-slate-500">
              <tr>
                {headings.map((heading) => (
                  <th key={heading} className="px-5 py-3 font-medium">
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70">
              {tab === 'orders' &&
                snapshot.orders.map((order) => (
                  <tr key={order.id} className="hover:bg-slate-800/30">
                    <td className="px-5 py-4 text-slate-400">{formatTime(order.createdAt)}</td>
                    <td className="px-5 py-4">
                      <span className="font-semibold">{order.instrument.symbol}</span>
                      <span className="ml-2 text-slate-500">
                        {order.instrument.market} · {order.strategyId}
                      </span>
                    </td>
                    <td className={`px-5 py-4 ${order.side === 'BUY' ? 'text-rose-300' : 'text-sky-300'}`}>
                      {order.side === 'BUY' ? '매수' : '매도'}
                    </td>
                    <td className="px-5 py-4 tabular-nums">
                      {formatDecimal(order.quantity, 0)} / {formatDecimal(order.filledQuantity, 0)}
                    </td>
                    <td className="px-5 py-4 tabular-nums">
                      {formatMoney(order.limitPrice, order.instrument.market === 'KR' ? 'KRW' : 'USD')}
                    </td>
                    <td className="px-5 py-4">
                      <span className={order.state === 'RISK_REJECTED' ? 'text-amber-200' : 'text-slate-300'}>
                        {orderLabels[order.state]}
                      </span>
                      {order.codes.map((code) => (
                        <p key={code} className="mt-1 text-[11px] text-slate-500" title={code}>
                          {codeLabel(code)}
                        </p>
                      ))}
                    </td>
                  </tr>
                ))}
              {tab === 'fills' &&
                snapshot.fills.map((fill) => {
                  const currency = fill.instrument.market === 'KR' ? 'KRW' : 'USD';
                  return (
                    <tr key={fill.id} className="hover:bg-slate-800/30">
                      <td className="px-5 py-4 text-slate-400">{formatTime(fill.createdAt)}</td>
                      <td className="px-5 py-4 font-semibold">
                        {fill.instrument.symbol}{' '}
                        <span className="ml-1 font-normal text-slate-500">{fill.instrument.market}</span>
                      </td>
                      <td className={`px-5 py-4 ${fill.side === 'BUY' ? 'text-rose-300' : 'text-sky-300'}`}>
                        {fill.side === 'BUY' ? '매수' : '매도'}
                      </td>
                      <td className="px-5 py-4 tabular-nums">{formatDecimal(fill.quantity, 0)}</td>
                      <td className="px-5 py-4 tabular-nums">{formatMoney(fill.price, currency)}</td>
                      <td className="px-5 py-4 tabular-nums text-slate-400">{formatMoney(fill.costs, currency)}</td>
                      <td className={`px-5 py-4 tabular-nums ${profitClass(fill.realizedPnl)}`}>
                        {fill.side === 'BUY' ? '—' : formatMoney(fill.realizedPnl, currency)}
                      </td>
                    </tr>
                  );
                })}
              {tab === 'events' &&
                snapshot.events.map((event) => (
                  <tr key={event.id} className="hover:bg-slate-800/30">
                    <td className="px-5 py-4 text-slate-400">{formatTime(event.createdAt)}</td>
                    <td className={`px-5 py-4 ${isFailure(event.kind) ? 'text-amber-200' : 'text-slate-300'}`}>
                      {isFailure(event.kind) ? '● ' : ''}
                      {eventLabel(event.kind)}
                    </td>
                    <td className="px-5 py-4 text-slate-400">
                      {event.codes.length
                        ? event.codes.map((code) => (
                            <span key={code} className="mr-3" title={code}>
                              {codeLabel(code)}
                            </span>
                          ))
                        : '—'}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
