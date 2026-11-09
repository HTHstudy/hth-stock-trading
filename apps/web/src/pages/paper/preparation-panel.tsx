import { useQuery } from '@tanstack/react-query';
import { PAPER_API } from '@shared/api/paper';
import { formatMoney, formatTime } from '@shared/lib/format';

const labels = {
  paperSource: '실제 시세용 Paper 출처',
  stopped: '매매 정지',
  noLease: 'worker 소유 기록 없음',
  initialControl: '초기 정지 상태 보존',
  limitsMatch: '투자 한도 일치',
  initialCash: '초기 가상 현금 일치',
  emptyPositions: '초기 보유분 없음',
  unreconciled: '실제 시세 대사 전 상태',
  initialPnl: '초기 손익 보존',
  noOrders: '주문 의도 없음',
  noFills: '모의 체결 없음',
  noReservations: '예약 없음',
  strategyMatches: '전략 설정 일치',
  historyMatches: '초기 변경 이력 일치',
  preparationReceipt: '검토 계획 기록 일치',
};
export function PreparationPanel() {
  const query = useQuery({
    queryKey: ['paper-preparation'],
    queryFn: ({ signal }) => PAPER_API.preparation(signal),
    refetchInterval: 10000,
    refetchOnWindowFocus: true,
  });
  const expired = Boolean(query.data && Date.now() - query.dataUpdatedAt > 30000);
  const state = query.isError || expired ? undefined : query.data;
  return (
    <section className="my-6 rounded-xl border border-line bg-panel p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold">실제 시세 Paper 준비 상태</h2>
        <button
          type="button"
          disabled={query.isFetching}
          onClick={() => {
            void query.refetch();
          }}
          className="rounded-lg border border-line-strong px-3 py-2 text-xs disabled:opacity-40"
        >
          {query.isFetching ? '확인 중…' : '준비 상태 새로고침'}
        </button>
      </div>
      <p className="mt-2 text-xs leading-6 text-muted">
        국내·미국의 별도 가상 계좌를 읽기 전용으로 확인합니다. 설정 일치는 매매 승인이나 시장 검증 완료를 뜻하지
        않습니다. 이 화면은 관측·평가·worker를 시작하지 않습니다.
      </p>
      <p className="mt-2 text-xs leading-6 text-muted">
        상단 긴급 정지의 대상은 기존 Paper 원장 연결 계좌입니다. 이 패널의 준비 계좌 제어·일일 기준 검토는 별도
        절차입니다.
      </p>
      {query.isPending && (
        <p role="status" className="mt-4 text-xs text-muted">
          준비 기록을 확인하고 있습니다…
        </p>
      )}
      {(query.isError || expired) && (
        <p role="alert" className="mt-4 text-xs text-warning">
          현재 준비 상태를 확인하지 못했습니다. 이전 결과를 정상 상태로 표시하지 않습니다.
        </p>
      )}
      {state?.status === 'disabled' && (
        <p className="mt-4 text-xs text-muted">
          준비 상태 조회가 서버에서 비활성화돼 있습니다. 기존 Paper 원장 연결과 별도 설정입니다.
        </p>
      )}
      {state?.status === 'unavailable' && (
        <p role="alert" className="mt-4 text-xs text-warning">
          일부 준비 기록이나 DB를 검증하지 못했습니다. 설정을 복구하거나 매매를 재개하지 않습니다.
        </p>
      )}
      {state && (
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          {state.accounts.map((account) => {
            const details = account.details;
            return (
              <article key={account.market} className="rounded-xl border border-line-strong/70 p-4">
                <h3 className="text-sm font-semibold">{account.market === 'KR' ? '국내' : '미국'} Paper 검증 계좌</h3>
                {!details && <p className="mt-3 text-xs text-warning">이 계좌의 현재 상태를 확인할 수 없습니다.</p>}
                {details && (
                  <>
                    <p className="mt-3 text-xs text-secondary">
                      {details.preparationMatches ? '초기 준비 설정 일치' : '초기 준비 상태와 차이 있음'} ·{' '}
                      {details.stopped ? '매매 정지' : '매매 정지 기록 아님'} ·{' '}
                      {details.leasePresent ? 'worker 소유 기록 있음' : 'worker 소유 기록 없음'}
                    </p>
                    {!details.clockVerified && (
                      <p role="alert" className="mt-3 text-xs text-warning">
                        DB 시각을 확인하지 못했습니다. 거래일 검토 필요 여부를 확정하지 않습니다.
                      </p>
                    )}
                    <p className="mt-3 text-xs text-warning">
                      {details.dailyReviewRequired === null
                        ? '일일 기준 검토 여부 확인 불가'
                        : details.dailyReviewRequired
                          ? '일일 기준 날짜 검토 필요'
                          : '현재 거래일과 일일 기준 날짜 일치'}
                    </p>
                    <div className="mt-2 text-[11px] leading-6 text-muted">
                      {details.dailyDates.map((date) => (
                        <p key={date.currency}>
                          {date.currency} 기준 {date.stored} → 현재 {date.current}
                        </p>
                      ))}
                    </div>
                    <p className="mt-4 text-[11px] text-subtle">검토한 가상 설정 · {details.plan.symbol}</p>
                    <dl className="mt-2 grid grid-cols-2 gap-3 text-xs">
                      <div>
                        <dt className="text-subtle">가상 초기 자금</dt>
                        <dd className="mt-1">{formatMoney(details.plan.cash, details.plan.currency)}</dd>
                      </div>
                      <div>
                        <dt className="text-subtle">1회 주문 한도</dt>
                        <dd className="mt-1">{formatMoney(details.plan.maxOrderAmount, details.plan.currency)}</dd>
                      </div>
                      <div>
                        <dt className="text-subtle">종목 투자 한도</dt>
                        <dd className="mt-1">{formatMoney(details.plan.maxInstrumentAmount, details.plan.currency)}</dd>
                      </div>
                      <div>
                        <dt className="text-subtle">일일 손실 차단 한도</dt>
                        <dd className="mt-1">{formatMoney(details.plan.maxDailyLoss, details.plan.currency)}</dd>
                      </div>
                      <div>
                        <dt className="text-subtle">이동평균 교차 · 1분봉</dt>
                        <dd className="mt-1">
                          {details.plan.fastPeriod} / {details.plan.slowPeriod}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-subtle">주문 수량 / 최대 종목 수</dt>
                        <dd className="mt-1">
                          {details.plan.quantity}주 / {details.plan.maxPositions}종목
                        </dd>
                      </div>
                    </dl>
                    <p className="mt-3 text-[11px] text-muted">
                      관측당 최대 모의 체결 {details.plan.maxFillQuantity}주 · 실제 시세 검증은 별도 진행
                    </p>
                    <details className="mt-4 text-xs text-muted">
                      <summary className="cursor-pointer">초기 준비 점검 항목</summary>
                      <ul className="mt-2 space-y-1">
                        {Object.entries(details.checks).map(([key, passed]) => (
                          <li key={key}>
                            {passed ? '일치' : '확인 필요'} · {labels[key as keyof typeof labels]}
                          </li>
                        ))}
                      </ul>
                    </details>
                    <p className="mt-4 text-[10px] text-subtle">DB 조회 시각 {formatTime(details.observedAt)}</p>
                  </>
                )}
              </article>
            );
          })}
        </div>
      )}
      {state && (
        <p className="mt-4 text-[10px] text-subtle">
          응답 시각 {formatTime(state.asOf)} · 한도는 비용 포함 · 거래일 검토와 매매 재개는 별도 절차입니다.
        </p>
      )}
    </section>
  );
}
