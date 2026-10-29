import { lazy, Suspense, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DASHBOARD_API } from '@shared/api/dashboard';
import { formatDecimal, formatMoney, formatTime, profitClass } from '@shared/lib/format';
import { DataQualityPanel } from './data-quality';
import { WatchlistEditor } from './watchlist-editor';

const PriceChart = lazy(() => import('./price-chart').then((module) => ({ default: module.PriceChart })));

const errors: Record<string, string> = {
  PERMISSION_DENIED: '토스 Open API의 허용 IP와 접근 권한을 확인해주세요.',
  AUTHENTICATION_FAILED: '토스 인증에 실패했습니다. 서버의 API 키 설정을 확인해주세요.',
  BROKER_LEASE_BUSY: '다른 조회 작업이 실행 중입니다. 잠시 후 다시 시도해주세요.',
  RATE_LIMITED: '토스 호출 한도에 도달했습니다. 잠시 후 다시 조회해주세요.',
  NETWORK_ERROR: '토스 서버에 연결할 수 없습니다. 네트워크를 확인해주세요.',
  TIMEOUT: '조회 응답이 지연되고 있습니다. 잠시 후 다시 시도해주세요.',
  REFRESH_TIMEOUT: '전체 조회 시간이 초과됐습니다. 잠시 후 다시 시도해주세요.',
  READONLY_CONFIGURATION_INVALID: '서버의 토스 키와 DB 설정을 확인해주세요.',
};

export function OverviewPage() {
  const queryClient = useQueryClient();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [marketFilter, setMarketFilter] = useState<'ALL' | 'KR' | 'US'>('ALL');
  const query = useQuery({
    queryKey: ['dashboard'],
    queryFn: ({ signal }) => DASHBOARD_API.get(signal),
    refetchInterval: 3000,
  });
  const refresh = useMutation({
    mutationFn: DASHBOARD_API.refresh,
    onSuccess: (result) => queryClient.setQueryData(['dashboard'], result),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
  const state = query.data;
  const snapshot = state?.snapshot;
  const selected = snapshot?.watchlist.find((instrument) => instrument.key === selectedKey) ?? snapshot?.watchlist[0];
  const holdings =
    snapshot?.holdings.filter((holding) => marketFilter === 'ALL' || holding.market === marketFilter) ?? [];
  const busy = state?.refreshing || refresh.isPending;
  const now = query.dataUpdatedAt || Date.now();
  const stale = snapshot ? now - Date.parse(snapshot.collectedAt) > 180_000 : false;
  const connectionLabel = query.isError
    ? '서버 연결 끊김'
    : busy
      ? '데이터 조회 중'
      : state?.connection === 'connected'
        ? '토스 연결됨'
        : state?.connection === 'error'
          ? '조회 실패'
          : state?.connection === 'disabled'
            ? '연동 비활성'
            : state?.connection === 'unconfigured'
              ? '설정 필요'
              : state?.connection === 'connecting'
                ? '시세 조회 대기'
                : '연결 확인 중';

  return (
    <div className="min-h-screen bg-[#0b1120] text-slate-200">
      <main id="overview" className="mx-auto max-w-[1600px] px-5 py-7 sm:px-9 xl:ml-56 xl:px-10">
        <header className="flex flex-wrap items-center justify-between gap-5 border-b border-slate-800/80 pb-7">
          <div>
            <p className="text-xs tracking-wider text-slate-500">HTH TRADING / OVERVIEW</p>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight">내 투자 현황</h1>
            <p className="mt-2 text-xs text-slate-400">
              {snapshot
                ? `${snapshot.accountCount}개 계좌 · 마지막 조회 ${formatTime(snapshot.collectedAt)}`
                : '토스증권에서 실제 데이터를 불러옵니다.'}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <span className="rounded-full border border-amber-300/20 bg-amber-300/5 px-3 py-1.5 text-[11px] font-semibold text-amber-200">
              PAPER · 주문 비활성
            </span>
            <button
              onClick={() => refresh.mutate()}
              disabled={!state?.canRefresh || busy}
              className="flex items-center gap-2 rounded-lg bg-teal-300 px-4 py-2.5 text-xs font-semibold text-slate-950 transition hover:bg-teal-200 disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-500"
              title="토스 재조회는 최소 30초 간격입니다."
            >
              <span className={busy ? 'animate-spin' : ''}>↻</span>
              {busy ? '조회 중…' : '새로고침'}
            </button>
          </div>
        </header>

        <div className="my-5 flex flex-wrap items-center justify-between gap-3 text-xs">
          <span className="flex items-center gap-2">
            <span
              className={`h-1.5 w-1.5 rounded-full ${state?.connection === 'connected' && !query.isError ? 'bg-teal-300' : 'bg-amber-300'}`}
            />
            {connectionLabel}
            <span className="ml-2 text-slate-500">수동 조회 · 거래소 데이터 기준</span>
          </span>
          <span className="text-slate-500">매매 전략 미실행 · 모든 보유분 조회 전용</span>
        </div>

        {(query.isError ||
          state?.error ||
          state?.connection === 'disabled' ||
          state?.connection === 'unconfigured' ||
          stale ||
          refresh.isError) && (
          <div
            role="alert"
            className="mb-6 rounded-xl border border-amber-300/20 bg-amber-300/5 px-5 py-4 text-sm leading-6 text-amber-100"
          >
            {query.isError
              ? '대시보드 API에 연결할 수 없습니다. API 서버가 실행 중인지 확인해주세요.'
              : state?.error
                ? (errors[state.error] ?? '데이터 조회에 실패했습니다. 잠시 후 다시 시도해주세요.')
                : state?.connection === 'disabled'
                  ? '서버에서 읽기 전용 대시보드를 활성화해주세요. 아직 데이터를 조회하지 않았습니다.'
                  : state?.connection === 'unconfigured'
                    ? '서버의 토스 API 키와 DB 설정이 필요합니다.'
                    : refresh.isError
                      ? '재조회 요청에 실패했습니다. 잠시 후 다시 시도해주세요.'
                      : '마지막 조회 후 3분이 지났습니다. 최신 상태를 보려면 새로고침해주세요.'}
            {snapshot && <span className="ml-2 text-amber-200/70">아래는 마지막으로 성공한 조회 결과입니다.</span>}
          </div>
        )}

        <section aria-label="자산 요약" className="grid gap-4 md:grid-cols-3">
          {(['KRW', 'USD'] as const).map((currency) => {
            const portfolio = snapshot?.portfolios.find((item) => item.currency === currency);
            return (
              <article key={currency} className="rounded-2xl border border-slate-800 bg-[#111a2b] p-6">
                <div className="flex items-center justify-between text-xs text-slate-400">
                  <span>{currency === 'KRW' ? '국내 주식 평가액' : '미국 주식 평가액'}</span>
                  <span className="rounded-md bg-slate-800 px-2 py-1 font-mono text-[10px]">{currency}</span>
                </div>
                <p className="mt-5 text-3xl font-semibold tracking-tight tabular-nums">
                  {formatMoney(portfolio?.value, currency)}
                </p>
                <p className={`mt-3 text-sm tabular-nums ${portfolio ? profitClass(portfolio.pnl) : 'text-slate-500'}`}>
                  {portfolio
                    ? `${formatDecimal(portfolio.pnl, currency === 'KRW' ? 0 : 2, true)} ${currency === 'KRW' ? '원' : 'USD'}`
                    : '—'}{' '}
                  <span className="ml-1 text-xs text-slate-500">평가 손익</span>
                </p>
                <div className="mt-5 flex justify-between border-t border-slate-800 pt-4 text-xs text-slate-500">
                  <span>매수 가능 금액</span>
                  <span className="tabular-nums text-slate-300">{formatMoney(portfolio?.buyingPower, currency)}</span>
                </div>
              </article>
            );
          })}
          <article className="rounded-2xl border border-slate-800 bg-[#111a2b] p-6">
            <p className="text-xs text-slate-400">보유 종목</p>
            <p className="mt-5 text-3xl font-semibold tabular-nums">
              {snapshot ? snapshot.holdings.length : '—'}
              <span className="ml-2 text-base font-normal text-slate-500">종목</span>
            </p>
            <p className="mt-3 text-sm text-slate-400">기존 보유분 포함 · 자동매매 편입 없음</p>
            <div className="mt-5 flex justify-between border-t border-slate-800 pt-4 text-xs text-slate-500">
              <span>USD/KRW 기준 환율</span>
              <span className="tabular-nums text-slate-300">
                {snapshot ? `${formatDecimal(snapshot.exchangeRate.midRate)}원` : '—'}
              </span>
            </div>
          </article>
        </section>
        <p className="mt-3 text-[11px] text-slate-500">
          평가액은 보유 주식 기준이며 현금을 포함하지 않습니다. 평가 손익은 수수료·세금 미반영입니다.
        </p>

        <DataQualityPanel quality={snapshot?.dataQuality} now={now} />

        <section id="watchlist" className="mt-8 grid scroll-mt-6 gap-5 lg:grid-cols-[1fr_300px]">
          <article className="min-w-0 overflow-hidden rounded-2xl border border-slate-800 bg-[#111a2b]">
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 px-6 py-5">
              <div>
                <h2 className="text-sm font-semibold">
                  {selected ? `${selected.name} · ${selected.symbol}` : '종목 차트'}
                </h2>
                <p className="mt-1.5 text-xs text-slate-500">
                  {selected
                    ? `${selected.market === 'KR' ? '국내' : '미국'} · ${selected.interval === '1m' ? '1분봉' : '일봉'} · ${selected.candles.length}개 봉`
                    : '실제 캔들 조회 후 표시됩니다.'}
                </p>
              </div>
              <div className="text-right">
                <p className="text-lg font-medium tabular-nums">
                  {selected ? formatMoney(selected.price, selected.currency) : '—'}
                </p>
                <p className="mt-1 text-[10px] text-slate-500">{formatTime(selected?.timestamp)}</p>
              </div>
            </div>
            {selected ? (
              <Suspense
                fallback={<div className="grid h-80 place-items-center text-sm text-slate-500">차트 로딩 중…</div>}
              >
                <PriceChart instrument={selected} />
              </Suspense>
            ) : (
              <div className="grid h-80 place-items-center text-sm text-slate-500">
                {busy || query.isPending ? '국내·미국 시세를 조회하고 있습니다…' : '표시할 시세 데이터가 없습니다.'}
              </div>
            )}
            <div className="flex flex-wrap justify-between gap-2 border-t border-slate-800 px-6 py-3 text-[10px] text-slate-500">
              <span>미확정 봉 포함 · 전략 판단용 데이터 아님</span>
              <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer" className="hover:text-slate-300">
                TradingView Lightweight Charts™
              </a>
            </div>
          </article>
          <article className="rounded-2xl border border-slate-800 bg-[#111a2b] p-5">
            <h2 className="text-sm font-semibold">관심 종목</h2>
            <WatchlistEditor />
            <p className="mt-2 text-xs text-slate-500">종목을 선택하면 차트가 바뀝니다.</p>
            <div className="mt-5 space-y-2">
              {snapshot?.watchlist.map((instrument) => (
                <button
                  key={instrument.key}
                  aria-pressed={selected?.key === instrument.key}
                  onClick={() => setSelectedKey(instrument.key)}
                  className={`flex w-full items-center justify-between rounded-xl border p-4 text-left transition ${selected?.key === instrument.key ? 'border-teal-300/30 bg-teal-300/5' : 'border-transparent hover:bg-slate-800/60'}`}
                >
                  <span>
                    <span className="block text-sm font-medium">{instrument.name}</span>
                    <span className="mt-1 block font-mono text-[10px] text-slate-500">
                      {instrument.symbol} · {instrument.market}
                    </span>
                  </span>
                  <span className="text-sm tabular-nums">{formatMoney(instrument.price, instrument.currency)}</span>
                </button>
              ))}
              {!snapshot && <p className="py-6 text-sm text-slate-500">시세 조회 대기 중</p>}
              {snapshot && !snapshot.watchlist.length && (
                <p className="py-6 text-sm text-slate-500">관심종목을 추가하면 시세와 차트를 조회할 수 있습니다.</p>
              )}
            </div>
            <h3 className="mt-8 border-t border-slate-800 pt-5 text-xs font-medium text-slate-400">
              시장 정규장 · 한국 시간
            </h3>
            <div className="mt-4 space-y-4">
              {snapshot?.markets.map((day) => {
                const regular = day.sessions.find((session) => session.type === 'regular');
                const open = regular && now >= Date.parse(regular.startsAt) && now < Date.parse(regular.endsAt);
                return (
                  <div key={day.market}>
                    <div className="flex justify-between text-xs">
                      <span>{day.market === 'KR' ? '국내 시장' : '미국 시장'}</span>
                      <span className={open ? 'text-teal-300' : 'text-slate-500'}>
                        {!day.sessionsKnown
                          ? '정보 미제공'
                          : day.sessions.length === 0
                            ? '휴장'
                            : open
                              ? '정규장 진행 중'
                              : '정규장 종료/대기'}
                      </span>
                    </div>
                    <p className="mt-1.5 text-[10px] leading-5 text-slate-500">
                      {regular ? `${formatTime(regular.startsAt)} ~ ${formatTime(regular.endsAt)}` : day.tradingDate}
                    </p>
                  </div>
                );
              })}
            </div>
          </article>
        </section>

        <section
          id="holdings"
          className="mt-8 scroll-mt-6 overflow-hidden rounded-2xl border border-slate-800 bg-[#111a2b]"
        >
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 px-6 py-5">
            <div>
              <h2 className="text-sm font-semibold">보유 종목</h2>
              <p className="mt-1.5 text-xs text-slate-500">토스 계좌 기준 · 계좌번호는 표시하지 않습니다.</p>
            </div>
            <div className="flex rounded-lg bg-slate-900 p-1" aria-label="시장 필터">
              {(['ALL', 'KR', 'US'] as const).map((filter) => (
                <button
                  key={filter}
                  aria-pressed={marketFilter === filter}
                  onClick={() => setMarketFilter(filter)}
                  className={`rounded-md px-3 py-1.5 text-xs ${marketFilter === filter ? 'bg-slate-700 text-white' : 'text-slate-500 hover:text-slate-300'}`}
                >
                  {filter === 'ALL' ? '전체' : filter === 'KR' ? '국내' : '미국'}
                </button>
              ))}
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="border-b border-slate-800 text-[11px] text-slate-500">
                <tr>
                  {['종목', '보유 수량', '평균 매입가', '현재가', '평가액', '평가 손익'].map((label, index) => (
                    <th key={label} className={`px-6 py-4 font-normal ${index ? 'text-right' : ''}`}>
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {holdings.map((holding) => (
                  <tr key={holding.key} className="border-b border-slate-800/60 last:border-0 hover:bg-slate-800/25">
                    <td className="px-6 py-4">
                      <span className="font-medium">{holding.name}</span>
                      <span className="mt-1 block font-mono text-[10px] text-slate-500">
                        {holding.symbol} · {holding.market}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-right tabular-nums text-slate-400">
                      {formatDecimal(holding.quantity, 6).replace(/\.?0+$/, '')}
                    </td>
                    <td className="px-6 py-4 text-right tabular-nums text-slate-400">
                      {formatMoney(holding.averagePurchasePrice, holding.currency)}
                    </td>
                    <td className="px-6 py-4 text-right tabular-nums">
                      {formatMoney(holding.lastPrice, holding.currency)}
                    </td>
                    <td className="px-6 py-4 text-right tabular-nums">
                      {formatMoney(holding.value, holding.currency)}
                    </td>
                    <td className={`px-6 py-4 text-right tabular-nums ${profitClass(holding.pnl)}`}>
                      <span className="block">
                        {formatDecimal(holding.pnl, holding.currency === 'KRW' ? 0 : 2, true)}
                      </span>
                      <span className="mt-1 block text-[11px]">
                        {holding.pnlPercent === null ? '—' : `${formatDecimal(holding.pnlPercent, 2, true)}%`}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {holdings.length === 0 && (
              <div className="px-6 py-12 text-center text-sm text-slate-500">
                {snapshot
                  ? '이 시장에 보유한 종목이 없습니다.'
                  : busy
                    ? '보유 종목을 조회하고 있습니다…'
                    : '조회가 완료되면 보유 종목을 표시합니다.'}
              </div>
            )}
          </div>
        </section>
        <footer className="mt-7 flex flex-wrap justify-between gap-3 pb-3 text-[10px] leading-6 text-slate-600">
          <span>HTH Trading · 개인용 읽기 전용 대시보드</span>
          <span>수익률은 조회 가격 기준 · 자동매매 미실행 · 조회 실패 시 마지막 성공 데이터를 유지합니다.</span>
        </footer>
      </main>
    </div>
  );
}
