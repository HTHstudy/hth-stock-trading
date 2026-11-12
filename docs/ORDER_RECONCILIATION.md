# 누적 주문 snapshot의 체결 대사

2026-11-12 [주문 조회](ORDER_READONLY.md) 다음 단계로 누적 체결 비교 순수 함수를 구현했다. **원장 반영·주문 전송·재전송·실제 조회·계좌 재개는 구현/실행하지 않았다.** 실거래 연동을 구성하는 계산 단계이며 실제 자산의 체결/잔고 대사 완료를 뜻하지 않는다.

## 역할과 입력

- [공통 JSON 계약](../packages/contracts/src/order-observation.ts): order-observation-v1. server scope·관측 시각·주문 reference·종목/통화/방향·요청 정의·정규화 상태·누적 execution을 strict Zod로 검증한다. 기존 currency/decimal/instant 규칙은 node-free primitives 파일로 그대로 옮겨 같은 공개 export를 유지했다.
- [worker 변환기](../apps/worker/src/order-observation.ts): BrokerOrder를 공통 모델로 변환한다. raw DTO나 broker import를 trading 도메인으로 전달하지 않는다. scope/observedAt은 신뢰된 호출 문맥에서 받고 주문 응답으로 계좌/전략 소유권을 추정하지 않는다. 변환기만으로 계좌 바인딩이 인증되지는 않는다.
- [순수 대사 함수](../packages/trading/src/execution/order-reconciliation.ts): reconcileOrderObservations(previous, next). broker·DB·파일·네트워크·현재 시각에 접근하지 않는다. Decimal precision 100과 최대 30자 십진 입력으로 차이를 계산하며 입력을 변경하지 않는다.

scope는 서버가 정하는 broker/계좌 범위의 opaque hash다. 원시 계좌/키를 넣거나 reference만으로 범위를 추정하지 않는다. 이전 기준이 없으면 명시적 null을 사용하고, 입력 오류/undefined를 없는 기준으로 취급하지 않는다. 첫 snapshot의 기존 체결을 전체 신규 체결로 소급 생성하지 않는다.

계약의 시각은 밀리초 정밀도이며 현재 Toss adapter의 UTC 정규화 출력과 맞춘다. 원시 고정밀 시각을 비교 함수에서 몰래 잘라 받지 않는다. 관측 시각은 비교 순서 검사일 뿐 제공자의 sequence·현재 데이터 신선도나 거래 권한을 증명하지 않는다. 동일 시각의 다른 내용은 임의로 최신을 선택하지 않는다.

## 상태 변환

Toss의 PENDING/PARTIAL_FILLED/FILLED, 취소/정정 대기, CANCELED/REJECTED/REPLACED를 broker와 독립된 상태로 매핑한다. CANCEL_REJECTED/REPLACE_REJECTED는 원주문의 거부/종료로 오인하지 않고 change-rejected로 둔다. 미지 코드, known=false, 알 수 없는 호가/유효 조건은 unknown으로 남긴다. 문자열이 FILLED여도 known=false이면 승격하지 않는다. prototype 이름과 같은 미지 값도 Map lookup으로 처리한다.

공식 OrderStatus의 의미는 2026-11-12 공개 OpenAPI 1.2.28에서 재확인했다. 원문 SHA-256은 `c5918961335ccd6b091577e307dc06ed505b58f83e4d99f0c4617de14ceb036a`로 직전 확인과 같았다. 이 확인은 공개 문서 GET뿐이며 계좌/주문 API 호출은 없다. [공식 OpenAPI](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json)

## 판정

| outcome           | 의미와 결과                                                                                                       |
| ----------------- | ----------------------------------------------------------------------------------------------------------------- |
| baseline-required | 이전 기준 없음. delta=null. 최초 체결을 신규 이벤트로 만들지 않음                                                 |
| unchanged         | 같은 의미의 누적 값/상태. 1과 1.000 등 십진 표현 차이는 동일. delta=null                                          |
| progress          | 알려진 수량 기반 주문에서 누적 수량 증가와 알려진 금액/비용의 차이. 개별 체결가·체결 ID는 만들지 않음             |
| cost-adjustment   | 수량·체결 금액은 같고 알려진 누적 수수료/세금만 변경. 음수 차이도 별도 정정 후보로 보존                           |
| metadata-change   | 상태·취소 시각·정산 예정일 등 변경. 신규 체결/정산 완료를 뜻하지 않음                                             |
| review-required   | 미지 상태/정의·변경 거부 레코드·금액 주문·null 비용/금액·시각 누락·경제값 정정/혼합 변화. 계산 가능한 차이만 표시 |
| blocked           | 계약/범위/정의/시각/수량 모순·역행·종료 후 재개 등. delta=null                                                    |

delta.quantity는 누적 체결량의 증가량이며 매도 포지션의 음수 변화량이 아니다. delta.amount/commission/tax는 양쪽이 알려진 경우에만 누적값의 차이, 한쪽이라도 null이면 null이다. 평균가×수량으로 금액을 복원하거나 그 평균을 새 체결가로 사용하지 않는다. 모든 결과에 ledgerApplied/canApplyToLedger/ownershipVerified/executionEnabled/canResend/canResume=false를 유지한다. 비교 결과를 그대로 원장 쓰기 명령으로 쓰지 않는다.

## 주요 불변조건

1. scope/reference·종목/통화/방향·원래 요청 정의가 일치해야 한다. 같은 reference의 수량/가격/금액/호가/유효 조건/주문 시각 변경을 자동 정정하지 않는다. optional 필드의 누락과 null도 구분한다. 정정으로 생긴 다른 ID는 새 바인딩 근거 없이 연결하지 않는다.
2. 관측 시각 역전, 같은 시각의 다른 내용, 주문 전/관측 후의 체결·취소 시각과 최종 체결 시각 역행을 차단한다. 미래 wall clock 신선도는 이 함수의 검증 범위가 아니다.
3. 누적 수량/체결 금액 감소를 자동 환원하지 않는다. 종료된 상태가 바뀌거나 체결량이 늘면 별도 확인 대상으로 차단한다. 취소 전 partial에서 canceled로 가며 체결량이 증가한 경우는 누적 차이로 관측할 수 있다.
4. 수량 기반 주문의 요청량 초과·pending의 체결량·partial/filled의 수량 모순·체결량과 금액/평균가의 명백한 모순은 차단한다. 금액 기반 주문은 요청 수량과의 전량 관계를 추정하지 않고 review-required다.
5. 이전/현재 금액·비용 null은 0이 아니다. pending 0주→부분 체결이라도 이전 금액/비용이 null이면 해당 차이는 null이다. 명시적으로 알려진 0 기준은 계산에 쓸 수 있지만 이 함수가 그 기준을 만들거나 소유권을 인증하지 않는다.
6. 체결량이 늘지 않은 금액/평균가 수정은 신규 체결로 만들지 않는다. 비용만 확정/환급되면 signed 비용 정정으로 구분하고, 체결 증가와 비용 감소가 섞이면 review-required다. 정산 예정일은 확정 정산의 증거가 아니다.

## 남은 원장 연결 작업

이 함수는 stateless다. 반복 호출이나 2→3 뒤에 1→3을 다시 비교해도 전역 중복 방지를 하지 않는다. 미래 적용 계층은 저장된 마지막 기준/버전·원본 관측과 의도/주문 바인딩을 고정하고, 영구 중복 키·행 잠금/CAS·정지 epoch·단일 실행 소유권과 같은 트랜잭션에서 검증해야 한다. review/blocked 결과를 버리고 다음 snapshot을 새 기준으로 덮어쓰는 우회도 허용하지 않는다.

원장 수량·현금·원가·수수료 반영, 수동 보유분 보호와 실제 주문 상태 머신/불확실 응답 복구는 아직 연결하지 않았다. 주문 ID가 없는 timeout을 종목/시각으로 추정 매칭하거나 재전송하지 않는다. 이번 common scope 문자열과 계산 통과를 그 실행 권한으로 확대하지 않는다. 기존 Paper 원장/계좌·예약 차단은 변경하지 않았다.

다음 구현은 가짜 주문 source로 **저장된 마지막 대사 기준의 중복 적용/CAS를 검증하는 오프라인 실행 경로**다. 실제 주문 쓰기 API나 실거래 활성화는 별도 작업으로 남긴다.

## 검증 범위

가짜 공통 snapshot과 broker 정규화 객체로 중복/부분 체결/전량 체결·취소 직전 증가·체결 후 환급·null→확정·시각/수량/금액 역행·상태 모순·고정밀 차이·unknown/변경 거부·범위/정의 변경·입력 불변성과 원문 비노출을 검사한다. 테스트는 실제 broker·키·계좌를 사용하지 않는다. 새 의존성/서비스·마이그레이션·자동 실행 경로·HTTP/CLI는 추가하지 않았다.

후속 [합성 대사 기준 저장소](ORDER_REVIEW_STORE.md)는 영구 작업 키·기준 CAS·보류 상태와 이력 연결까지 전용 테스트 DB에서 검증한다. 원장 반영/실주문을 연결한 것은 아니다.

## 2026-11-12 최종 검증

대사/변환 관련 가짜 입력 테스트 60개가 통과했다. 새 일회용 localhost 전용 hth_readonly_test DB의 최종 로컬 verify:ci는 기본 병렬 설정으로 143파일·1,434개 테스트(테스트 구간 61.98초), 포맷·린트·타입·전체 빌드를 통과했다. 두 Compose 설정·문서 링크·diff도 통과했다. 원격 CI/실연결·실제 원장/체결 대사 결과는 아니다. 사용자 DB·키/계좌·예약을 사용하지 않았다.
