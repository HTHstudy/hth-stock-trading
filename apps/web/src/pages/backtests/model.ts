import type { BacktestArtifact, BacktestSummary } from '@hth/contracts';

export function sourceLabel(report: Pick<BacktestSummary, 'dataset' | 'datasetRequest'>) {
  if (report.dataset.source === 'synthetic-demo' || report.datasetRequest.source.startsWith('synthetic-'))
    return '합성 데모';
  return report.dataset.source === 'database' ? 'DB 입력' : '파일 입력';
}
function normalize(value: string) {
  const [whole = '', fraction = ''] = value.split('.');
  return `${whole.replace(/^0+(?=\d)/, '')}.${fraction.replace(/0+$/, '')}`;
}
export function comparisonBlocker(first: BacktestSummary, second: BacktestSummary): string | null {
  if (first.dataset.contentHash !== second.dataset.contentHash)
    return '데이터셋이 달라 곡선을 겹치지 않습니다. 아래 조건과 지표를 개별 확인하세요.';
  if (first.currency !== second.currency) return '통화가 달라 곡선을 겹치지 않습니다.';
  if (normalize(first.config.initialCash) !== normalize(second.config.initialCash))
    return '초기 자산이 달라 곡선을 겹치지 않습니다.';
  return null;
}
export function chartPoints(equity: BacktestArtifact['report']['equity']) {
  const points = new Map<number, number>();
  for (const point of equity) {
    const time = Math.floor(Date.parse(point.timestamp) / 1000);
    const value = Number(point.cumulativeReturnPct);
    if (!Number.isFinite(time) || !Number.isFinite(value)) return null;
    points.set(time, value);
  }
  return [...points].sort(([left], [right]) => left - right).map(([time, value]) => ({ time, value }));
}
export const signalStatuses: Record<BacktestArtifact['report']['signals'][number]['status'], string> = {
  HOLD: '관망',
  PENDING: '대기',
  FILLED: '체결',
  INSUFFICIENT_CASH: '현금 부족',
  INVALID_PRICE: '가격 오류',
  ALREADY_LONG: '추가 매수 차단',
  NO_POSITION: '보유 수량 없음',
  SUPERSEDED: '반대 신호로 폐기',
  PENDING_EXISTS: '기존 의도 유지',
  UNFILLED_END: '종료 시 미체결',
};
