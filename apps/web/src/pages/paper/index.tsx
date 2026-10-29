import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PAPER_API } from '@shared/api/paper';
import { formatDecimal, formatMoney, formatTime, profitClass } from '@shared/lib/format';
import { PaperHistory } from './history';
import type { HistoryTab } from './history';
import { StrategyEditor } from './strategy-editor';
import { StrategyHistory } from './strategy-history';

const queryKey = ['paper-dashboard'] as const;
const buttonFocus = 'focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-teal-300';
export function PaperPage() {
  const [tab, setTab] = useState<HistoryTab>('orders');
  const [editing, setEditing] = useState<string | null>(null);
  const [history, setHistory] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const client = useQueryClient();
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => PAPER_API.get(signal),
    refetchInterval: (current) => (current.state.data?.status === 'disabled' ? false : 2000),
  });
  const stop = useMutation({
    mutationFn: PAPER_API.stop,
    retry: false,
    onMutate: () => client.cancelQueries({ queryKey }),
    onSuccess: () => client.invalidateQueries({ queryKey }),
  });
  const snapshot = query.data?.status === 'ready' ? query.data.snapshot : null;
  const source = snapshot?.source ?? 'unverified';
  const sourceLabel = !snapshot
    ? query.isPending
      ? '출처 확인 중'
      : '계좌 미연결'
    : source === 'toss-readonly'
      ? '실제 시세 PAPER'
      : source === 'synthetic-only'
        ? '합성 PAPER'
        : '출처 미확인';
  const stale = query.isError || snapshot?.valuation.stale;
  const running = snapshot && !snapshot.control.stopped && snapshot.worker.state === 'active';
  return (
    <main className="mx-auto max-w-[1600px] px-5 py-7 text-slate-200 sm:px-9 xl:ml-56 xl:px-10">
      <header className="flex flex-wrap items-center justify-between gap-5 border-b border-slate-800 pb-7">
        <div>
          <p className="text-xs tracking-wider text-slate-500">HTH TRADING / PAPER</p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">Paper 모의매매</h1>
          <p className="mt-2 text-xs text-slate-400">별도 모의 원장의 자산과 실행 기록을 확인합니다.</p>
        </div>
        <div className="flex items-center gap-3">
          <span className="rounded-full border border-amber-300/20 bg-amber-300/5 px-3 py-1.5 text-[11px] font-semibold text-amber-200">
            {sourceLabel}
          </span>
          <button
            className={`rounded-lg border border-slate-700 px-4 py-2.5 text-xs text-slate-300 disabled:opacity-40 ${buttonFocus}`}
            disabled={query.isFetching}
            onClick={() => {
              void query.refetch();
            }}
          >
            새로고침
          </button>
          <button
            disabled={!snapshot || stop.isPending}
            onClick={() => stop.mutate()}
            className={`flex items-center gap-2 rounded-lg border border-rose-400/30 bg-rose-400/10 px-4 py-2.5 text-xs font-semibold text-rose-200 hover:bg-rose-400/20 disabled:opacity-35 ${buttonFocus}`}
          >
            <span className="h-2 w-2 rounded-[2px] bg-current" />
            {stop.isPending ? '정지 확인 중…' : '긴급 정지'}
          </button>
        </div>
      </header>
      <p className="my-5 rounded-xl border border-amber-300/15 bg-amber-300/5 px-5 py-4 text-xs leading-6 text-amber-100">
        {!snapshot
          ? '연결된 모의 계좌의 출처와 실행 상태를 조회합니다.'
          : source === 'toss-readonly'
            ? '토스 시세를 사용하는 모의 거래입니다. 현금·보유분·체결은 별도 모의 원장이며 실제 계좌와 연결되지 않습니다.'
            : source === 'synthetic-only'
              ? '합성 데이터로 검증하는 모의 거래입니다.'
              : '데이터 출처를 확인하지 못했습니다. 출처가 확인되지 않은 계좌는 실행하거나 전략을 편집할 수 없습니다.'}{' '}
        표시된 금액과 성과는 실제 투자 결과가 아닙니다. 긴급 정지는 모의 실행만 멈추며 보유 주식을 자동 매도하지
        않습니다.
      </p>
      {saved && (
        <p
          role="status"
          className="mb-5 rounded-xl border border-teal-300/20 bg-teal-300/5 px-5 py-4 text-xs text-teal-200"
        >
          전략 설정을 저장하고 모의 실행을 정지했습니다. 재개 시 저장된 조건을 사용합니다.
        </p>
      )}
      {stop.isSuccess && (
        <p
          role="status"
          className="mb-5 rounded-xl border border-teal-300/20 bg-teal-300/5 px-5 py-4 text-xs leading-6 text-teal-200"
        >
          정지를 기록했습니다. 실행기가 남은 예약을 정리하며, 이미 체결한 보유분은 유지합니다. 자동으로 재개하지
          않습니다.
        </p>
      )}
      {stop.isError && (
        <p role="alert" className="mb-5 rounded-xl border border-rose-400/20 px-5 py-4 text-xs text-rose-200">
          정지 여부를 확인하지 못했습니다. 상태를 새로고침하고 필요하면 긴급 정지를 다시 눌러 주세요.
        </p>
      )}
      {query.isError && (
        <p role="alert" className="mb-5 rounded-xl border border-rose-400/20 px-5 py-4 text-xs leading-6 text-rose-200">
          Paper 데이터를 조회하지 못했습니다.
          {snapshot
            ? ' 아래는 마지막 수신값이며 현재 상태를 보장하지 않습니다.'
            : ' 서버 연결과 모의 계좌 설정을 확인해 주세요.'}
        </p>
      )}
      {query.isPending && (
        <p role="status" className="py-20 text-center text-sm text-slate-400">
          모의 원장을 조회하고 있습니다…
        </p>
      )}
      {query.data?.status === 'disabled' && (
        <section className="rounded-2xl border border-dashed border-slate-700 bg-[#0d1424] px-8 py-20 text-center">
          <p className="text-xs font-medium tracking-[0.2em] text-slate-500">PAPER WORKSPACE</p>
          <h2 className="mt-4 text-lg font-semibold">아직 연결된 모의 계좌가 없습니다</h2>
          <p className="mx-auto mt-3 max-w-md text-sm leading-7 text-slate-400">
            로컬 Paper 계좌를 연결하면 자산과 주문·체결 기록을 확인할 수 있습니다. 연결만으로 모의 거래가 시작되지는
            않습니다.
          </p>
        </section>
      )}
      {snapshot && (
        <>
          <section aria-label="모의 실행 상태" className="mb-5 grid gap-4 md:grid-cols-3">
            <div className="rounded-xl border border-slate-800 bg-[#0d1424] p-5">
              <p className="text-xs text-slate-500">실행 제어</p>
              <p
                className={`mt-3 flex items-center gap-2 text-lg font-semibold ${running && !stale ? 'text-teal-200' : 'text-slate-200'}`}
              >
                <span className={`h-2 w-2 rounded-full ${running && !stale ? 'bg-teal-300' : 'bg-slate-500'}`} />
                {snapshot.control.stopped
                  ? '정지 상태'
                  : snapshot.worker.state !== 'active'
                    ? '실행기 확인 필요'
                    : stale
                      ? '데이터 확인 필요'
                      : '모의 실행 중'}
              </p>
              <p className="mt-2 text-[11px] text-slate-500">
                {snapshot.control.reason === 'DASHBOARD_EMERGENCY_STOP'
                  ? '대시보드에서 긴급 정지를 기록했습니다.'
                  : '재개는 별도의 명시적 절차가 필요합니다.'}
              </p>
            </div>
            <div className="rounded-xl border border-slate-800 bg-[#0d1424] p-5">
              <p className="text-xs text-slate-500">실행기 소유권</p>
              <p className="mt-3 text-lg font-semibold">
                {snapshot.worker.state === 'active'
                  ? 'Lease 유효'
                  : snapshot.worker.state === 'expired'
                    ? 'Lease 만료'
                    : '실행기 없음'}
              </p>
              <p className="mt-2 text-[11px] text-slate-500">
                {snapshot.worker.leaseUntil
                  ? `유효 기한 ${formatTime(snapshot.worker.leaseUntil)}`
                  : '현재 실행 소유권이 없습니다.'}
              </p>
            </div>
            <div className="rounded-xl border border-slate-800 bg-[#0d1424] p-5">
              <p className="text-xs text-slate-500">원장 평가</p>
              <p className={`mt-3 text-lg font-semibold ${stale ? 'text-amber-200' : 'text-slate-200'}`}>
                {stale ? '갱신 필요' : '최근 관측 반영'}
              </p>
              <p className="mt-2 text-[11px] text-slate-500">
                평가 {formatTime(snapshot.valuation.observedAt)} · 조회 {formatTime(snapshot.asOf)}
              </p>
            </div>
          </section>
          <section aria-label="통화별 모의 자산" className="grid gap-5 lg:grid-cols-2">
            {snapshot.portfolios.map((portfolio) => (
              <article key={portfolio.currency} className="rounded-2xl border border-slate-800 bg-[#0d1424] p-6">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-medium text-slate-400">
                    {portfolio.currency === 'KRW' ? '원화' : '달러'} 모의 자산
                  </h2>
                  <span className="rounded-md bg-slate-800 px-2 py-1 text-[10px] font-semibold text-slate-400">
                    {portfolio.currency}
                  </span>
                </div>
                <p className="mt-4 break-all text-3xl font-semibold tracking-tight tabular-nums">
                  {formatMoney(portfolio.equity, portfolio.currency)}
                </p>
                <dl className="mt-6 grid grid-cols-2 gap-x-5 gap-y-4 border-t border-slate-800 pt-5">
                  {[
                    ['현금', portfolio.cash],
                    ['예약 현금', portfolio.reservedCash],
                    ['가용 현금', portfolio.availableCash],
                    ['보유 평가액', portfolio.holdingsValue],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <dt className="text-[11px] text-slate-500">{label}</dt>
                      <dd className="mt-1 text-sm tabular-nums">{formatMoney(value, portfolio.currency)}</dd>
                    </div>
                  ))}
                </dl>
                <div className="mt-5 flex flex-wrap justify-between gap-2 border-t border-slate-800 pt-4 text-xs">
                  <span className="text-slate-500">일일 평가손익 · {portfolio.tradingDate}</span>
                  <span className={`font-medium tabular-nums ${profitClass(portfolio.dailyPnl)}`}>
                    {formatMoney(portfolio.dailyPnl, portfolio.currency)}
                  </span>
                </div>
              </article>
            ))}
          </section>
          <section className="mt-6 rounded-2xl border border-slate-800 bg-[#0d1424]">
            <h2 className="border-b border-slate-800 px-5 py-5 text-sm font-semibold">
              보유 종목 <span className="ml-2 text-xs font-normal text-slate-500">{snapshot.positions.length}</span>
            </h2>
            {!snapshot.positions.length ? (
              <p className="py-12 text-center text-sm text-slate-500">보유 중인 모의 주식이 없습니다.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full whitespace-nowrap text-left text-xs">
                  <thead className="text-slate-500">
                    <tr>
                      {['종목', '전체 / 수동 수량', '전략 소유 수량', '평가 단가', '평가액'].map((heading) => (
                        <th key={heading} className="px-5 py-3 font-medium">
                          {heading}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/70">
                    {snapshot.positions.map((position) => {
                      const currency = position.instrument.market === 'KR' ? 'KRW' : 'USD';
                      return (
                        <tr key={`${position.instrument.market}:${position.instrument.symbol}`}>
                          <td className="px-5 py-4 font-semibold">
                            {position.instrument.symbol}{' '}
                            <span className="ml-1 font-normal text-slate-500">{position.instrument.market}</span>
                          </td>
                          <td className="px-5 py-4 tabular-nums">
                            {formatDecimal(position.quantity, 0)} / {formatDecimal(position.manualQuantity, 0)}
                          </td>
                          <td className="px-5 py-4 text-slate-400">
                            {position.ownership.length
                              ? position.ownership.map((owner) => (
                                  <span key={owner.strategyId} className="mr-3">
                                    {owner.strategyId} · {formatDecimal(owner.quantity, 0)}주
                                  </span>
                                ))
                              : '수동 보유'}
                          </td>
                          <td className="px-5 py-4 tabular-nums">{formatMoney(position.markPrice, currency)}</td>
                          <td className="px-5 py-4 tabular-nums">{formatMoney(position.value, currency)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <section className="mt-6 rounded-2xl border border-slate-800 bg-[#0d1424] p-5">
            <h2 className="text-sm font-semibold">등록 전략</h2>
            <div className="mt-4 flex flex-wrap gap-3">
              {snapshot.strategies.length ? (
                snapshot.strategies.map((strategy) => (
                  <div key={strategy.id} className="rounded-lg border border-slate-700/70 px-4 py-3">
                    <span
                      className={`mr-2 inline-block h-1.5 w-1.5 rounded-full ${strategy.enabled ? 'bg-teal-300' : 'bg-slate-600'}`}
                    />
                    <span className="text-xs font-medium">{strategy.id}</span>
                    <span className="ml-3 text-[11px] text-slate-500">
                      v{strategy.version} · {strategy.enabled ? '등록 활성' : '비활성'}
                      {' · 리비전 '}
                      {strategy.revision}
                    </span>
                    {strategy.definition && (
                      <p className="mt-2 text-[11px] text-slate-500">
                        {strategy.definition.instrument.market} · {strategy.definition.instrument.symbol} · MA{' '}
                        {strategy.definition.parameters.fastPeriod}/{strategy.definition.parameters.slowPeriod} · 주문{' '}
                        {strategy.definition.quantity}주 / 체결 최대 {strategy.definition.maxFillQuantity}주
                      </p>
                    )}
                    <button
                      type="button"
                      disabled={source === 'unverified'}
                      onClick={() => {
                        setEditing(strategy.id);
                        setSaved(false);
                      }}
                      className="mt-3 block rounded-md border border-slate-700 px-3 py-2 text-[11px] text-teal-200 hover:bg-slate-800 disabled:opacity-40"
                    >
                      설정 · 활성 관리
                    </button>
                    <button
                      type="button"
                      className="mt-2 block rounded-md border border-slate-700 px-3 py-2 text-[11px] text-slate-300 hover:bg-slate-800"
                      onClick={() => setHistory(history === strategy.id ? null : strategy.id)}
                    >
                      변경 이력
                    </button>
                  </div>
                ))
              ) : (
                <p className="text-xs text-slate-500">등록된 전략이 없습니다.</p>
              )}
            </div>
            <p className="mt-3 text-[11px] text-slate-500">
              전략이 등록 활성 상태여도 실행 제어가 정지되어 있으면 거래하지 않습니다.
            </p>
            {snapshot.strategies
              .filter((strategy) => strategy.id === editing && source !== 'unverified')
              .map((strategy) => (
                <StrategyEditor
                  key={strategy.id}
                  strategy={strategy}
                  source={source === 'toss-readonly' ? 'toss-readonly' : 'synthetic-only'}
                  onClose={() => setEditing(null)}
                  onSaved={() => {
                    setSaved(true);
                    setEditing(null);
                  }}
                />
              ))}
            {snapshot.strategies
              .filter((strategy) => strategy.id === history)
              .map((strategy) => (
                <StrategyHistory
                  key={strategy.id}
                  id={strategy.id}
                  revision={strategy.revision}
                  onClose={() => setHistory(null)}
                />
              ))}
          </section>
          <section className="mt-6 overflow-hidden rounded-2xl border border-slate-800 bg-[#0d1424]">
            <div className="flex flex-wrap gap-1 px-3 pt-3" aria-label="원장 이력 선택">
              {(
                [
                  ['orders', '주문'],
                  ['fills', '체결'],
                  ['events', '이벤트 · 실패'],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  aria-pressed={tab === value}
                  onClick={() => setTab(value)}
                  className={`rounded-lg px-4 py-3 text-xs ${buttonFocus} ${tab === value ? 'bg-teal-300/10 font-semibold text-teal-200' : 'text-slate-400 hover:bg-slate-800'}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <PaperHistory snapshot={snapshot} tab={tab} />
          </section>
        </>
      )}
    </main>
  );
}
