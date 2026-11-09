import type { PaperValidationRun } from '@hth/contracts';

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
  PAPER_STRATEGY_WARMUP_INSUFFICIENT: '전략 계산에 필요한 확정 봉 부족',
  PAPER_ACCOUNT_NOT_PRISTINE: '초기 계좌 상태와 차이 있음',
  PAPER_CONFIGURATION_CHANGED: '설정 변경',
  PAPER_CLEANUP_INCOMPLETE: '종료 정리 미완료',
  PAPER_VALIDATION_NOT_COMPLETED: '검증 미완료',
  PAPER_MARKET_PLAN_INVALID: '검증 계획 파일 읽기 또는 형식 오류',
  PAPER_MARKET_PLAN_HASH_MISMATCH: '검증 계획 해시 불일치',
  PAPER_VALIDATION_RESOURCE_INVALID: '고정 검증 입력 묶음 오류',
  PAPER_VALIDATION_PAUSED: '정지 상태로 검증 조기 종료',
  PAPER_VALIDATION_WAITING: '휴장 대기 상태로 검증 조기 종료',
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
  const uncertain = run.clock === 'unverified';
  const fullRun =
    run.state === 'terminal-recorded' &&
    (run.resultState === 'completed' ||
      run.resultState === 'completed-with-incomplete-review' ||
      run.resultState === 'review-issues-found') &&
    run.completedTicks === 60 &&
    run.runningTicks === 60;
  const executionLabel =
    run.state === 'awaiting-result'
      ? '실행: 종료 기록 없음'
      : fullRun
        ? '실행: 60회 실행 완료'
        : run.resultState === 'execution-ended-early'
          ? '실행: 조기 종료'
          : run.resultState === 'stopped-before-run-or-failed'
            ? '실행: 시작 전 정지 또는 실패'
            : '실행: 종료 기록 있음 · 완료 기준 미충족';
  return {
    execution: {
      label: executionLabel,
      className: fullRun && !uncertain ? 'text-accent' : 'text-warning',
    },
    review: {
      label: run.verdict ? `검증: ${validationVerdictLabels[run.verdict]}` : '검증: 대사 기록 없음 · 미검증',
      className: run.verdict === 'consistent-observed-state' && !uncertain ? 'text-accent' : 'text-warning',
    },
  };
}
