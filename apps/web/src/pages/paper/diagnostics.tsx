import { useQuery } from '@tanstack/react-query';
import { PAPER_API } from '@shared/api/paper';
import { formatTime } from '@shared/lib/format';
import { codeLabel, orderLabels } from './model';
const stages = {
  control: '실행 제어',
  source: '수집·원장 관측',
  data: '입력 데이터 검증',
  fill: '기존 모의 주문 체결',
  strategy: '전략 평가',
  reservation: '주문 의도·리스크 예약',
};
export function Diagnostics({ source }: { source: string }) {
  const query = useQuery({
    queryKey: ['paper-diagnostics', source],
    queryFn: ({ signal }) => PAPER_API.diagnostics(signal),
    refetchInterval: 5000,
  });
  const data = query.isError ? undefined : query.data;
  return (
    <section aria-label="전략 실행 진단" className="mt-6 rounded-2xl border border-slate-800 bg-[#0d1424] p-5">
      <h2 className="text-sm font-semibold">전략 신호·주문 차단 진단</h2>
      <p className="mt-3 text-xs leading-6 text-slate-400">
        worker가 실제 판단했을 때 저장한 기록입니다. 조회로 전략을 다시 평가하거나 거래를 재개하지 않습니다. 과거 신호는
        현재 매매 권한이 아니며, BUY/SELL 신호만으로 주문이나 체결을 뜻하지 않습니다.
      </p>
      {query.isPending && (
        <p role="status" className="py-8 text-xs text-slate-500">
          저장된 진단을 읽고 있습니다…
        </p>
      )}
      {query.isError && (
        <p role="alert" className="mt-4 text-xs text-rose-300">
          진단 조회 또는 무결성 확인에 실패했습니다. 이전 결과를 현재 판단으로 표시하지 않습니다.
        </p>
      )}
      {data && (
        <>
          <p className="mt-3 text-xs text-slate-400">
            조회 {formatTime(data.asOf)} · 현재 계좌 {data.stopped ? '실행 정지' : '모의 실행 허용'} · worker{' '}
            {data.workerState === 'active' ? 'lease 유효' : data.workerState === 'expired' ? 'lease 만료' : '없음'} ·{' '}
            {data.source === 'toss-readonly'
              ? '실제 시세 Paper'
              : data.source === 'synthetic-only'
                ? '합성 Paper'
                : '출처 미확인 · 조회 전용'}
          </p>
          {!data.items.length && <p className="py-8 text-xs text-slate-500">등록된 전략이 없습니다.</p>}
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            {data.items.map(({ strategy, latest, configurationCurrent, stale }) => (
              <article key={strategy.id} className="rounded-xl border border-slate-800 p-4">
                <h3 className="text-sm font-semibold">{strategy.id}</h3>
                <p className="mt-2 text-xs text-slate-500">
                  현재 등록 {strategy.enabled ? '활성' : '비활성'} · 리비전 {strategy.revision}
                  {strategy.definition
                    ? ` · ${strategy.definition.instrument.market}:${strategy.definition.instrument.symbol}`
                    : ' · 저장 조건 미등록'}
                </p>
                {!latest ? (
                  <p className="mt-4 text-xs leading-6 text-slate-400">
                    저장된 실행 진단이 없습니다. 미평가 또는 조회 범위 밖일 수 있으며 신호·미매수 사유를 추정하지
                    않습니다.
                  </p>
                ) : (
                  <>
                    <p className="mt-4 text-xs text-slate-400">
                      당시 평가 {formatTime(latest.report.evaluatedAt)} · 저장 {formatTime(latest.recordedAt)}
                    </p>
                    {(stale || !configurationCurrent) && (
                      <p className="mt-2 text-xs text-amber-200">
                        {stale ? '오래된 기록 · ' : ''}
                        {!configurationCurrent ? '현재 설정과 다른 리비전 · ' : ''}현재 판단으로 사용하지 마세요.
                      </p>
                    )}
                    <p className="mt-3 text-sm font-medium text-teal-200">
                      {latest.report.action === null ? '신호 평가 안 함' : `당시 신호 ${latest.report.action}`} ·{' '}
                      {stages[latest.report.stage]}
                    </p>
                    <ul className="mt-3 space-y-2 text-xs text-slate-300">
                      {[...new Set(latest.report.codes)].map((code) => (
                        <li key={code} title={code}>
                          {codeLabel(code)} <span className="text-[10px] text-slate-600">{code}</span>
                        </li>
                      ))}
                    </ul>
                    <p className="mt-3 text-[11px] text-slate-500">
                      당시 대상 {latest.report.instrument.market}:{latest.report.instrument.symbol} · 리비전{' '}
                      {latest.report.strategyRevision} ·{' '}
                      {latest.report.closedCandles === null
                        ? '봉 검증 미실행'
                        : `검증 종료 봉 ${latest.report.closedCandles}개`}
                      {latest.report.barAt ? ` · 마지막 봉 ${formatTime(latest.report.barAt)}` : ''}
                    </p>
                    {latest.report.orderState && (
                      <p className="mt-2 text-xs text-slate-400">
                        당시 모의 주문 상태: {orderLabels[latest.report.orderState] ?? latest.report.orderState}
                      </p>
                    )}
                  </>
                )}
              </article>
            ))}
          </div>
          <p className="mt-3 text-[11px] text-slate-500">
            현재 전략 최대 100개 · 최근 진단 20묶음에서 전략별 마지막 기록 조회
            {data.limited ? ' · 이전 기록은 포함되지 않을 수 있습니다.' : ''}
          </p>
        </>
      )}
    </section>
  );
}
