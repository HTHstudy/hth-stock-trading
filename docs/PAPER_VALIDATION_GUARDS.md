# 유한 Paper 검증의 선행 관측·조기 종료

2026-11-09 [체결 경로 계획](PAPER_EXECUTION_PATH_PLAN.md)에서 확인한 두 검증 공백을 보강했다. 설정·한도·기존 계좌의 pristine 요구는 유지한다. 실제 관측·토큰 발급·Paper 재개·새 예약·기존 결과 수정 없이 코드와 가짜 입력/전용 임시 DB로 검증한다.

## 선행 관측 연결

`verifyPaperPrerequisite`는 이미 파일 schema/hash·journal 전체 합계·순서를 검증한 reader 결과를 받아 선택 조건만 검사한다. 이 helper 자체가 파일 진위/바이트 hash를 다시 확인하거나 공식 캘린더를 조회하는 것은 아니다.

- job은 completed이며 해당 report UUID에 연결돼야 한다. job과 report 모두 고정 계획의 시장·종목과 정확히 같아야 한다.
- 요청/기록은 모두 60개, 관측 간격도 job과 manifest가 같아야 한다. completed·toss-readonly·최종 hash 검증·terminal·60 healthy/성공·오류/closed/blocked/회귀/공백/부분 기록 없음이 필요하다.
- 계획한 정규 세션 안에 job 시작·manifest 시작·전체 journal 첫 표본 시작과 마지막 표본 종료·리포트 완료가 있어야 한다. 종료는 세션 끝보다 엄격히 앞서야 하며 시각 역행·미래 완료·세션 밖 현재 시각은 거부한다.
- 저장 선행 리포트는 완료 후 **15분 이내**에만 재사용한다. 정확히 15분은 허용하고 초과는 거부한다. 여러 시간 전의 같은 세션 리포트를 새 실행 준비 근거로 재사용하지 않기 위한 보수적 고정값이며 CLI에서 늘리는 옵션은 없다. 실제 quote·캔들 신선도는 기존 시장 데이터 정책으로 별도 검사한다.

화면 DTO의 `recentSamples`는 최대 50개다. `createObservationReports.getWithSampleRange`는 같은 제한/검증 경로로 전체 journal을 읽어 첫 `startedAt`·마지막 `finishedAt`을 추가 반환한다. 공개 HTTP의 `get` 응답과 50개 상한은 바꾸지 않는다. 첫 열 표본이 다른 세션에 속하는데 화면용 최근 50개만 보고 통과시키지 않는다. 빈/미완료 자료도 내부 reader에서 범위를 반환할 수 있으나 검증 guard는 최종 자료만 채택한다.

선택 시점과 정지 관측/일일 검토를 마친 **재개 직전**에 다시 읽어 검사한다. job·manifest·완료 시각·journal hash·집계·전체 표본 범위를 묶은 `evidenceHash`가 같아야 한다. 그 사이 변조·교체·만료·자료 소실이 있으면 재개하지 않는다. 초기 선택은 새 실행의 `observation-evidence.json`, 재개 직전 선택은 별도 `prerequisite-before-run.json`으로 남기며 덮어쓰지 않는다.

이 검사는 **계획 시각과 관측 구간의 연결**이다. 관측 리포트에는 공식 세션 원문이 없으므로 `actualSessionVerified=false`를 유지하고, 현재 source의 공식 캘린더·정지 1회 관측·`prepareStrategyData`·21봉 검사는 기존대로 수행한다. 설정 hash·리포트 선택의 성공은 실행/재개 승인이나 시장 데이터 신선도 인증이 아니다. 오류는 기존 `PREREQUISITE_FAILED`로 축약하며 원문/경로/계좌를 로그에 넣지 않는다.

## 정지·휴장의 조기 종료

`runGuardedPaperValidationPhase`는 유한 검증 runner의 재개 단계에만 적용한다. 일반 worker의 run loop나 idle/서비스 동작은 변경하지 않는다.

1. tick 상태를 먼저 보존한다.
2. 재개 구간에서 첫 `paused` 또는 `waiting`이 반환되면 callback에서 구분된 오류를 던져 다음 tick/대기로 가지 않게 한다.
3. 기존 worker `finally`의 진행 작업·잔량 정리·lease 해제, 실제 시세 runtime의 pending source 정리·토큰 잠금 해제를 기다린다.
4. **직접 만든 동일 오류 객체**가 정리 후 돌아오고 실행에 전달한 동일 취소/기한 신호가 취소되지 않은 경우에만 예상된 조기 종료로 분류한다. 정리 중 늦게 온 취소도 다시 확인한다. 정리 실패·취소·다른 오류 또는 같은 코드 문자열의 다른 오류는 삼키지 않는다.
5. 이후 after checkpoint·대사를 수행하며 기존 자산/원가를 보존한다. 정리 불일치나 원장 문제가 있으면 성공으로 바꾸지 않는다.

| 상태    | 저장 코드                  | 정상적인 조기 종료 결과                             |
| ------- | -------------------------- | --------------------------------------------------- |
| paused  | `PAPER_VALIDATION_PAUSED`  | `execution-ended-early`·exit 2, 정리/대사 별도 확인 |
| waiting | `PAPER_VALIDATION_WAITING` | 동일                                                |

원장 대사가 `issues-found`면 `review-issues-found`를 우선하며 조기 종료가 그 실패를 덮지 않는다. 정리 실패는 기존 실패 경로로 처리한다. 미체결/무신호는 incomplete를 유지한다. 두 코드는 strict 계약과 조회 화면에만 추가하며 과거 결과 파일/코드를 바꾸지 않는다. 모든 조회·결과의 executionEnabled/canResume 경계는 유지한다.

정지 1회 관측은 원래 paused여야 하므로 resume=false 단계에는 조기 종료 guard를 적용하지 않는다. 재개 구간의 running/HOLD와 개별 리스크 거부도 이 변경만으로 강제 종료하지 않는다. HOLD를 BUY로 바꾸거나 신호를 만들기 위해 계속 재시작하지 않는다. 이 guard는 tick이 끝나 상태를 반환한 시점의 정책이며, 진행 중 I/O 취소·heartbeat·deadline·긴급 정지 제어는 기존 절차다.

## 유지하는 경계와 검증

기존 pristine 계좌 gate·version/epoch CAS·단일 lease·한도·손실 이월·기본 정지·자동 재시도 금지·고정 코드 검사는 유지한다. 주문 이력이 생긴 계좌의 후속 실행과 1주 설정에서의 부분 체결 지원을 추가하지 않는다. a407 예약 감사와 장시간 감독기의 차단도 그대로다.

회귀 검사는 다음을 구분한다.

- strict 입력·같은 시장의 다른 종목·job/report 연결·간격 불일치·다른 세션·전체 첫 표본·미래/역행·15분 경계·최종 재검사 hash 변경·미완료/오류/공백 거부.
- 실제 파일 reader의 60개 전체 범위·공개 50개 DTO 보존·hash 변조/경로 거부.
- 가짜 실행 단계의 첫 paused/waiting 후 다음 tick 미실행·정리 후 반환·정리/취소 오류 전파·정지 1회/HOLD 보존.
- fake build/clock의 CLI에서 선행 거부가 .env·계좌·DB 단계 전에 종료되고 요청/종료 증거를 보존하는지 확인.
- 새 UUID 합성 전용 DB에서 실제 worker.run을 guard로 감싸 첫 정지/휴장 tick 뒤 lease·예약 정리와 부분 체결 자산 보존을 확인. 이는 실제 시세 실행 증거가 아니다.

새 의존성·DB 스키마·실제 주문 API·실행 예약은 추가하지 않는다.

## 최종 검증 결과

2026-11-09 최종 소스를 고정하고 새 일회용 localhost 전용 PostgreSQL에서 `verify:ci`를 실행했다. 126파일·959개 테스트(71.64초), 포맷·린트·타입·전체 빌드와 두 Compose 설정 검사가 통과했다. 검사 전후 핵심 runner/guard/reader 파일 hash도 동일했다. 원격 Actions 결과는 아니다.

실제 계좌나 운영 DB는 사용하지 않았다. 직접 생성한 테스트 DB 컨테이너만 종료하며 기존 Paper·업무 DB·과거 실행/관측 파일은 보존한다. 실제 시장 신호/체결·장시간 token/session 검증 완료로 확대하지 않는다.
