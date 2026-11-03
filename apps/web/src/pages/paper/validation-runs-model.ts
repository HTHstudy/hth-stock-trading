import type { PaperValidationRun } from '@hth/contracts';

export const validationResultLabels = {
  completed: '종료 기록: 완료',
  'completed-with-incomplete-review': '종료 기록: 대사 미완료',
  'execution-ended-early': '종료 기록: 조기 종료',
  'review-issues-found': '종료 기록: 대사 문제 발견',
  'stopped-before-run-or-failed': '종료 기록: 시작 전 정지 또는 실패',
} satisfies Record<NonNullable<PaperValidationRun['resultState']>, string>;

export const validationCodeLabels = {
  CANCELLED: '취소 기록',
  BROKER_LEASE_BUSY: '읽기 전용 연결 소유권 사용 중',
  BROKER_LEASE_LOST: '읽기 전용 연결 소유권 상실',
  PAPER_TRADING_DAY_REVIEW_REQUIRED: '거래일 검토 필요',
  PAPER_WORKER_DATA_NOT_READY: '판단 데이터 준비 미완료',
  PAPER_OBSERVATION_STALE: '관측 자료 만료',
  PAPER_CONTROL_CHANGED: '정지 제어 상태 변경',
  PAPER_BUILD_CHANGED: '고정 빌드 변경',
  PAPER_VERSION_CONFLICT: '계좌 버전 충돌',
  PAPER_DAY_REVIEW_NOT_REQUIRED: '일일 검토 대상 아님',
  PAPER_TRADING_DAY_REVIEW_NOT_REQUIRED: '거래일 검토 대상 아님',
  PAPER_MARKET_STRATEGIES_INVALID: '실제 시세용 전략 설정 부적합',
  PREREQUISITE_FAILED: '사전 조건 불충족',
  PREREQUISITE_UNVERIFIED: '사전 조건 미검증',
  START_MISSED: '시작 예정 시각 놓침',
  PAPER_PREFLIGHT_FAILED: '시작 전 점검 불충족',
  PAPER_ACCOUNT_NOT_PRISTINE: '초기 계좌 상태와 차이 있음',
  PAPER_CONFIGURATION_CHANGED: '설정 변경',
  PAPER_CLEANUP_INCOMPLETE: '종료 정리 미완료',
  PAPER_VALIDATION_NOT_COMPLETED: '검증 미완료',
} satisfies Record<NonNullable<PaperValidationRun['code']>, string>;

export const validationCheckLabels = {
  checkpoints: '전후 체크포인트',
  comparable: '비교 가능성',
  beforeIntegrity: '사전 자료 무결성',
  afterIntegrity: '사후 자료 무결성',
  intervalEvidence: '구간 증거',
  priorFillsPreserved: '기존 체결 보존',
  priorEventsPreserved: '기존 이벤트 보존',
  priorIntentsPreserved: '기존 주문 의도 보존',
  configurationStable: '설정 유지',
  stopped: '정지 기록',
  leaseReleased: '소유권 해제',
  noOpenIntents: '미종결 주문 의도 없음',
  noActiveReservations: '활성 예약 없음',
  stoppedBaseline: '정지 기준 상태',
  workerCycle: '실행기 주기',
  intentPath: '주문 의도 경로',
  diagnosticsRecorded: '진단 기록',
  fillPath: '모의 체결 경로',
  externalChanges: '외부 변경 검사',
  cashMatchesFills: '현금과 체결 일치',
  positionsMatchFills: '보유분과 체결 일치',
  ownershipMatchesFills: '소유분과 체결 일치',
  manualHoldingsPreserved: '수동 보유분 보존',
  costBasisReplay: '원가 재현',
} satisfies Record<keyof NonNullable<PaperValidationRun['checks']>, string>;

export const validationEvidenceLabels = {
  'request-only': '요청 기록만 확인',
  'before-checkpoint': '사전 체크포인트 확인',
  'after-checkpoint': '사후 체크포인트 확인',
  'linked-review': '저장 대사 연결 확인',
} satisfies Record<PaperValidationRun['evidence'], string>;

export const validationVerdictLabels = {
  'issues-found': '대사 문제 발견',
  incomplete: '대사 미완료',
  'consistent-observed-state': '관측된 상태 일치',
} satisfies Record<NonNullable<PaperValidationRun['verdict']>, string>;

export function validationRunPresentation(run: PaperValidationRun) {
  if (run.clock === 'unverified') return { label: '시각 불확실 · 결과 해석 주의', className: 'text-amber-100' };
  if (run.state === 'awaiting-result') return { label: '종료 기록 없음', className: 'text-amber-100' };
  const complete =
    run.resultState === 'completed' && run.verdict === 'consistent-observed-state' && run.stoppedAndCleaned === true;
  return {
    label: run.resultState ? validationResultLabels[run.resultState] : '종료 결과 미확인',
    className: complete ? 'text-teal-200' : 'text-amber-100',
  };
}
