import { useQuery } from '@tanstack/react-query';
import { BACKTESTS_API } from '@shared/api/backtests';
import { formatMoney } from '@shared/lib/format';

const costLabels: Record<string, string> = {
  buyFeeBps: '매수 수수료 (bps)',
  sellFeeBps: '매도 수수료 (bps)',
  sellTaxBps: '매도세 (bps)',
  slippageBps: '슬리피지 (bps)',
};
const reasonLabels: Record<string, string> = {
  SAME_REPORT: '같은 리포트입니다.',
  DIFFERENT_DATASET: '동결 데이터셋이 다릅니다.',
  DIFFERENT_STRATEGY: '전략 조건이 다릅니다.',
  DIFFERENT_EXECUTION: '비용 외 체결 조건이 다릅니다.',
  COSTS_NOT_ORDERED: '비용 축을 낮은 비용·높은 비용 순으로 정렬할 수 없습니다.',
};
function traceLabel(value: boolean | null) {
  return value === null ? '미검증 (체결 없음 또는 증거 없음)' : value ? '일치' : '불일치';
}

export function CostComparison({ leftHash, rightHash }: { leftHash: string; rightHash: string }) {
  const query = useQuery({
    queryKey: ['backtest-cost-comparison', leftHash, rightHash],
    queryFn: ({ signal }) => BACKTESTS_API.compare(leftHash, rightHash, signal),
    enabled: Boolean(leftHash && rightHash),
    staleTime: Infinity,
    retry: false,
  });
  if (!leftHash || !rightHash) return null;
  // Never render a cached/late response for a different selected pair.
  const pair =
    query.data?.leftReportHash === leftHash && query.data.rightReportHash === rightHash ? query.data : undefined;
  const comparison = pair?.status === 'compared' ? pair.comparison : null;
  return (
    <section
      aria-label="비용 시나리오 · 추적 비교"
      className="mt-6 rounded-2xl border border-line bg-surface p-6 text-xs leading-6"
    >
      <h2 className="text-sm font-semibold">비용 시나리오 · 추적 비교</h2>
      <p className="mt-3 text-warning">
        모델 비용 시나리오 비교입니다. 실제 시장의 비용 영향이나 전략 수익성을 입증하지 않으며, 실행·재개 승인이
        아닙니다.
      </p>
      {query.isError ? (
        <p role="alert" className="mt-4 text-negative">
          비용 비교를 읽거나 검증할 수 없습니다. 이전 결과를 표시하지 않습니다.
        </p>
      ) : query.isPending || !pair ? (
        <p role="status" className="mt-4 text-muted">
          선택한 두 리포트의 비용 비교를 검증하고 있습니다…
        </p>
      ) : pair.status === 'incomparable' ? (
        <p role="status" className="mt-4 text-warning">
          비용 비교 불가: {reasonLabels[pair.reason ?? ''] ?? '비교 조건을 확인할 수 없습니다.'}
        </p>
      ) : comparison ? (
        <>
          <dl className="mt-4 grid gap-3 break-all text-secondary">
            <div>
              <dt className="text-subtle">낮은 비용 리포트 SHA-256</dt>
              <dd className="font-mono">{comparison.lowerReportHash}</dd>
            </div>
            <div>
              <dt className="text-subtle">높은 비용 리포트 SHA-256</dt>
              <dd className="font-mono">{comparison.higherReportHash}</dd>
            </div>
            <div>
              <dt className="text-subtle">변경된 비용 축</dt>
              <dd>
                {comparison.changedCostFields
                  .map((field) => costLabels[field] ?? `${field} (알 수 없는 비용 축)`)
                  .join(' · ') || '없음'}
              </dd>
            </div>
          </dl>
          <p className="mt-4 text-muted">차이의 방향: 높은 비용 − 낮은 비용 · 서버 계산값 · {pair.currency}</p>
          <dl className="mt-2 grid gap-3 text-secondary sm:grid-cols-2">
            <div>
              <dt className="text-subtle">순손익 차이</dt>
              <dd>{formatMoney(comparison.netPnlDelta, pair.currency)}</dd>
            </div>
            <div>
              <dt className="text-subtle">수수료 차이</dt>
              <dd>{formatMoney(comparison.feesDelta, pair.currency)}</dd>
            </div>
            <div>
              <dt className="text-subtle">체결 수 (낮은 비용 / 높은 비용)</dt>
              <dd>
                {comparison.lowerFillCount} / {comparison.higherFillCount}건
              </dd>
            </div>
            <div>
              <dt className="text-subtle">체결 수 일치</dt>
              <dd>{comparison.sameFillCount ? '일치 (건수만 비교)' : '불일치'}</dd>
            </div>
            <div>
              <dt className="text-subtle">모델 체결 경로: 시각·수량</dt>
              <dd>
                {traceLabel(
                  comparison.lowerFillCount === 0 && comparison.higherFillCount === 0
                    ? null
                    : comparison.sameFillTimingAndQuantity,
                )}
              </dd>
            </div>
            <div>
              <dt className="text-subtle">신호 판단</dt>
              <dd>{traceLabel(comparison.sameSignalDecisions)}</dd>
            </div>
          </dl>
          <p className="mt-4 text-muted">
            체결 수가 같아도 모델 체결 경로나 신호 판단이 같다는 뜻은 아닙니다. 미검증은 일치로 해석하지 않습니다.
          </p>
          {(comparison.lowerFillCount === 0 || comparison.higherFillCount === 0) && (
            <p className="mt-2 text-warning">
              체결 0건이 포함됩니다. 0 차이·빈 추적의 일치는 비용 영향 검증이나 거래 성공을 뜻하지 않습니다.
            </p>
          )}
        </>
      ) : (
        <p role="status" className="mt-4 text-warning">
          비교 결과를 확인할 수 없습니다.
        </p>
      )}
    </section>
  );
}
