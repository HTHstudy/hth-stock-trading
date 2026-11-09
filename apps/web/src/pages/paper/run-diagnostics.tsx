import type { PaperValidationRun } from '@hth/contracts';
import { codeLabel } from './model';

const stageLabels = {
  control: '실행 제어',
  source: '시세 수집',
  data: '입력 데이터 검증',
  fill: '모의 체결 처리',
  strategy: '전략 평가',
  reservation: '주문 예약',
};
export function RunDiagnostics({ diagnostics }: { diagnostics: PaperValidationRun['diagnostics'] }) {
  return (
    <section className="mt-3 rounded-lg border border-line-strong p-3">
      <h4 className="font-semibold">이 실행 구간의 전략 진단</h4>
      {!diagnostics ? (
        <p className="text-muted">연결된 진단 자료 없음 · 실행 원인을 추정하지 않습니다.</p>
      ) : diagnostics.availability === 'unavailable' ? (
        <p className="text-warning">진단 자료 검증 불가 · 원인을 표시하지 않습니다.</p>
      ) : (
        <>
          <p>
            저장 진단 묶음 {diagnostics.recordedBatches}개 · 전략별 판단 기록 {diagnostics.recordedReports}건
          </p>
          <p>
            매수 신호 {diagnostics.actions.BUY} · 매도 신호 {diagnostics.actions.SELL} · 관망 {diagnostics.actions.HOLD}{' '}
            · 신호 평가 전 단계 {diagnostics.actions.unevaluated}
          </p>
          <p className="text-muted">
            동일 진단의 반복 저장은 생략됩니다. 기록 수는 tick 수나 주문·체결 수와 다릅니다. 신호가 있어도 예약·체결을
            뜻하지 않습니다.
          </p>
          <ul>
            {Object.entries(diagnostics.stages).map(([stage, count]) => (
              <li key={stage}>
                {stageLabels[stage as keyof typeof stageLabels]} 단계: {count}건
              </li>
            ))}
          </ul>
          <ul>
            {diagnostics.reasons.map((reason) => (
              <li key={reason.code}>
                {codeLabel(reason.code)}: {reason.count}건
              </li>
            ))}
          </ul>
          <p className="text-muted">
            저장된 과거 구간의 진단입니다. 현재 데이터·설정의 유효성이나 기록되지 않은 tick의 판단을 보증하지 않습니다.
            한 판단에 사유가 여러 개면 각각 집계합니다.
          </p>
        </>
      )}
    </section>
  );
}
