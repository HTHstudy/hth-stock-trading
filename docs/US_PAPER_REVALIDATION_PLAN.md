# 미국 Paper 재검증 준비

현재 상태: 새 미국 실행 e3c96a51은 11/6 00:15:46 KST에 60 tick 종료·정리를 완료했다. 의도/체결 0·저장 진단 22건 HOLD/NO_CROSS이며 [최종 결과](US_PAPER_RESULT_2026_11_06.md)를 따른다. 아래는 이전 준비/예약 당시의 보존 기록이다.

2026-11-04 10:00 KST에 준비를 완료하고, 사용자의 후속 진행 요청에 따라 **10:09 KST에 일회성 예약을 시작했다**. 대기 로그·프로세스 생존을 확인했으며 Paper tick은 아직 시작하지 않았다. 이전 미국 실행의 계획 파일 누락 문제를 수정한 코드와 별도 고정 입력으로 준비했으며, 이전 실패 기록과 고정 빌드는 보존한다. 아래 준비 시점의 plan.json은 수정하지 않고 예약 증거를 별도 보관한다.

## 확인한 결과

- 소스 commit `b82018e769d56a1b850c414618f03a909b24309d`를 전체 빌드한 뒤 공개 산출물과 의존성만 별도 디렉터리에 복사했다. 환경파일·키·계좌 자료는 복사하지 않았다.
- 파일 16,827개와 내부 symlink 1,231개의 목록/hash를 기록했다. 외부를 가리키는 링크는 허용하지 않으며 고정 복사본에서 필요한 공개 모듈 import가 성공했다.
- 고정 실행기와 backend/lockfile fingerprint가 원본과 같았다. 별도 계획/manifest를 hash 검증하고 절대 경로로 전달한 읽기 전용 준비 점검이 통과했다.
- 미국 준비 계좌의 출처·정지·lease 없음·한도·초기 현금·보유분 없음·주문/체결/예약 없음·전략·이력·준비 receipt 검사가 모두 통과했다. 계좌 제어 version/epoch와 설정 hash를 별도 고정했다.
- 국내·미국 준비 계좌의 조회 시각을 제외한 원장 hash가 작업 전후 동일했다. 이번 작업에서 일일 기준 적용·정지 시세 관측·Paper tick·주문은 수행하지 않았다.
- 선행 관측 `us-2026-11-02`의 최종 journal hash와 60/60 healthy·오류/차단/공백 0을 재검증했다. 과거 관측은 현재 시세 신선도나 실행 승인을 대신하지 않는다.

## 공식 캘린더와 후보 시간

기존 broker 잠금 DB의 동일 client advisory lock 안에서 읽기 전용 adapter로 미국 거래 캘린더를 한 번 조회했다. 응답의 정규장 구간은 다음과 같다. 시각은 모두 KST다.

| 항목                   | 시각                            |
| ---------------------- | ------------------------------- |
| 미국 거래일            | 2026-11-04                      |
| 정규장                 | 11월 4일 23:30 ~ 11월 5일 06:00 |
| 실행 전 검사 시작 후보 | 11월 4일 23:35                  |
| 전체 절차 종료 기한    | 11월 5일 00:00                  |

위 시간으로 일회성 예약했다. 시작 시 캘린더·잔여 예산·계좌·고정 입력을 다시 확인한다. 최대 60 tick이며 검사와 수집이 기한 안에 완료된다는 보장은 없다. 시작을 놓치거나 검사에 실패하면 자동 연장·재시도·다음 날 이월하지 않는다.

캘린더 조회의 토큰 계측은 initial 성공 1회·실패/취소 0·종료 시 inFlight 0이었다. 관측 TTL은 86,399초이며 자연 만료 갱신 검증으로 해석하지 않는다.

## 보관한 증거

private 준비 루트는 `.local-data/paper-validation-preparations/1a4e97db-7397-495e-824c-4381e866edda/`다. 다음 파일은 Git에 넣지 않는다.

| 자료                    | 파일                                                      |
| ----------------------- | --------------------------------------------------------- |
| 준비 계획·후보 시각     | `plan.json`                                               |
| 공개 코드·의존성 복사본 | `build/`                                                  |
| 빌드 목록·메타데이터    | `build-inventory.json`, `build-snapshot.json`             |
| 고정 계획·manifest      | `inputs/61fe879e-7669-4f67-8105-aca541566c09/`            |
| 계좌 제어 조건          | `expected-controls.json`                                  |
| 읽기 전용 준비 기준     | `us-readonly-baseline.json`                               |
| 일일 검토 필요 여부     | `daily-review-readiness.json`                             |
| 선행 관측 확인          | `prerequisite-evidence.json`                              |
| 캘린더·안전한 토큰 계측 | `calendar-evidence.json`, `calendar-token-lifecycle.json` |

주요 fingerprint는 다음과 같다. checksum은 내용 연결 검증이며 운용 승인이나 출처 진위 증명이 아니다.

```text
plan:      4ff769b4f56668786f0830d0e7e7e504370b7b73291943be0bbaabbcb5d52140
build:     d849e9a5596f79d55c66330ab05985557d266a343caecab1e02ee5282e0a2cf1
inventory: 898cb19e3cf074b64b69fbc2526b9ec47e8f229f4a04da200033fa1668f8f233
resources: 157f72b277d93bddd7e78b711b83c55c772bb59d6f805490dd936ece00b19e49
controls:  d40a4a30908c09c4292054f1d560dd3edb46911387e1e59b58f853bf5b072e78
```

## 실제 실행 전에 남은 절차

준비 당시 plan.json은 `scheduled=false`, `resumeRequested=false`, `executionEnabled=false`, `canResume=false`로 보존한다. 이후 사용자 요청으로 [운영 실행기](PAPER_VALIDATION_PREFLIGHT.md)에 명시적인 --run/--resume-authorized와 모든 고정 입력을 전달했다. 새 request.json은 `resumeRequested=true`이며 실제 주문 권한인 `executionEnabled`는 계속 false다.

1. 고정 코드/입력/제어 파일·선행 관측을 재검증한다. 계좌 제어 상태나 manifest/설정이 달라졌다면 준비를 중단하고 새 검토를 만든다. 예전 값을 복원하지 않는다.
2. 실행 시점의 새 일일 검토 계획으로 날짜·손실 이월·신선한 전체 보유분 평가·lease/version/epoch를 확인한다. 이번 미리보기는 5분 유효이며 실행 시 재사용하지 않는다. 현재 기준일은 두 통화 모두 10월 30일로, 이번에는 변경하지 않았다.
3. 일일 검토 후 정지 상태 1회 실제 시세 검사와 실행 직전 checkpoint를 저장한다. 이번 baseline은 실행 직전 checkpoint를 대신하지 않는다.
4. 명시적으로 재개한 경우에만 겹치지 않는 최대 60 tick을 실행하고 기한 내 종료·정지·lease/잔량 정리를 확인한다. 초기화·마이그레이션은 하지 않는다.
5. 종료 checkpoint와 대사에서 현금·수량·소유권·비용·원가·미체결을 확인한다. 신호나 체결이 없으면 해당 경로는 계속 미검증이다. 전략·한도를 바꿔 체결을 유도하지 않는다.

## 예약 확인

예약 직전 동일 고정 빌드에서 계좌 준비 검사를 다시 수행했고, 현재 version/epoch·설정·manifest가 준비 시 고정한 값과 일치했다. 새 일일 기준 적용이나 Paper 재개는 아직 하지 않았다. 같은 준비 묶음의 중복 발사를 막는 dispatch 기록을 배타적으로 생성했으며, 동일 시장의 기한 내 미종료 요청이 있으면 새 발사를 거부했다.

- batch: `f8a7d192-c906-45c5-a7ac-8e91f5c2a502`
- run: `e7427018-3c6b-4a3e-ab3e-6aa6560b0b54`
- 실행 요청: `.local-data/paper-validation-runs/<run>/request.json`
- 발사/확인 증거: `.local-data/paper-validation-batches/<batch>/us-launch.json`, `launch-verification.json`
- 대기 로그: `waiting-for-prerequisite`, 시작 2026-11-04T14:35:00Z

기존 상태 조회 helper에서도 해당 run이 `awaiting-result`·`request-only`로 확인됐다. `/paper`의 저장된 실행 기록에는 종료 기록 없음과 예정 시간이 표시된다. 이 조회는 프로세스 생존을 검사하지 않으며, 별도의 OS 확인에서 예약 실행기와 해당 PID 수명에 연결한 caffeinate의 생존을 확인했다.

대기 중에는 키/DB/토큰 연결을 만들지 않는다. 임시 유휴 절전 방지를 걸었지만 PC 종료·덮개 닫기·수동 절전·재부팅 후 자동 복구를 제공하지 않는다. 실행기는 종료 checkpoint/대사/결과를 기록하고 종료하며 새 일정을 자동 생성하지 않는다. 후속 확인에서는 저장된 종료 결과를 검증해야 하고, 현재의 대기 증거를 실행 완료로 표현하지 않는다.

## 검증 범위

준비 전 전체 빌드가 통과했다. 준비 후 키/DB 없는 독립 확인에서 계획 hash·고정 실행기 fingerprint·고정 입력 검증이 다시 통과했고 `dbAccessed=false`를 확인했다. 실제 준비 점검과 계좌 전후 비교는 전용 Paper DB에서 읽기 전용으로 수행했다. 이번 작업은 운영 증거와 문서만 추가했으며 코드/스키마를 변경하지 않아 전체 테스트를 반복하지 않았다. 코드 수정의 기존 470개 테스트·타입·린트·빌드·포맷 결과는 [사전 점검 수정 기록](PAPER_VALIDATION_PREFLIGHT.md)에 보존한다.
