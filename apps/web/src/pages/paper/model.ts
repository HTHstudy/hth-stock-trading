export const orderLabels: Record<string, string> = {
  INTENT_RECORDED: '의도 기록',
  READY: '예약 중',
  PARTIALLY_FILLED: '부분 체결',
  FILLED: '체결 완료',
  RISK_REJECTED: '리스크 거부',
  ABORTED: '잔량 중단',
};
const eventLabels: Record<string, string> = {
  ACCOUNT_CREATED: '모의 계좌 생성',
  SOURCE_REJECTED: '데이터 출처 불일치 차단',
  LIMITS_CHANGED: '한도 변경',
  STRATEGY_CHANGED: '전략 설정 변경',
  LEASE_ACQUIRED: '실행 소유권 획득',
  WORKER_RECOVERED: '미완료 주문 복구',
  LEASE_RELEASED: '실행기 종료',
  ACCOUNT_OBSERVED: '평가 갱신',
  ACCOUNT_RECONCILED: '잔고 확인',
  PAPER_RESUMED: '명시적 재개',
  PAPER_STOPPED: '정지 기록',
  INTENT_RECORDED: '주문 의도 기록',
  INTENT_CONFLICT: '중복 주문 내용 충돌',
  INTENT_ABORTED: '미체결 잔량 중단',
  LEASE_REJECTED: '실행 소유권 거부',
  RISK_REJECTED: '리스크 검증 거부',
  RESERVATION_CREATED: '자금·수량 예약',
  FILL_CONFLICT: '중복 체결 내용 충돌',
  FILL_REJECTED: '모의 체결 거부',
  LIMIT_NOT_REACHED: '지정가 미도달',
  PAPER_FILL_RECORDED: '모의 체결 기록',
};
const codeLabels: Record<string, string> = {
  INSUFFICIENT_CASH: '가용 현금 부족',
  INSUFFICIENT_OWNED_QUANTITY: '전략 소유 수량 부족',
  DAILY_LOSS_LIMIT: '일일 손실 한도',
  ORDER_AMOUNT_LIMIT: '주문 금액 한도',
  INSTRUMENT_AMOUNT_LIMIT: '종목 투자 한도',
  MAX_POSITIONS: '보유 종목 한도',
  DUPLICATE_BUY: '기존 보유·매수 예약',
  DATA_NOT_READY: '시장 데이터 확인 필요',
  SOURCE_UNHEALTHY: '시세 수집 이상',
  SIGNAL_NOT_CURRENT: '신호·설정 버전 변경',
  EMERGENCY_STOP: '긴급 정지',
  STRATEGY_DISABLED: '전략 비활성',
  WORKER_RECOVERY: '재시작 복구',
  WORKER_EXPIRED: '예약 기한 만료',
  STALE_RESERVATION: '예약 유효성 상실',
  WORKER_SHUTDOWN: '정상 종료',
  WORKER_FINISHED: '실행 완료',
  WORKER_FAILED: '실행 오류',
  WORKER_STEP_FAILED: '주기 실행 오류',
  PAPER_FILL_DATA_NOT_READY: '체결 데이터 확인 필요',
  PAPER_DAILY_LOSS_LIMIT: '일일 손실 한도',
  PAPER_BASIS_MISMATCH: '전략 원가 확인 필요',
  PAPER_STRATEGY_CONFIG_MISMATCH: '저장된 전략 조건과 불일치',
};
export function eventLabel(kind: string) {
  return eventLabels[kind] ?? '기타 원장 이벤트';
}
export function codeLabel(code: string) {
  return codeLabels[code] ?? '실행 조건 확인 필요';
}
export function isFailure(kind: string) {
  return ['INTENT_CONFLICT', 'LEASE_REJECTED', 'RISK_REJECTED', 'FILL_CONFLICT', 'FILL_REJECTED'].includes(kind);
}
