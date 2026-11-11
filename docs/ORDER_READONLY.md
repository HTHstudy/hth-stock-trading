# 주문 목록·상세의 읽기 전용 연동

2026-11-11 실거래 실행 엔진에 필요한 주문 조회 capability를 추가했다. **주문 생성·정정·취소·실주문 전송·계좌 조회 실행은 하지 않았다.** 전략 성과 검증과 병행할 수 있는 주문 실행 기반 개발이며 현재 live 거부·Paper 기본 정지·예약 정책을 유지한다.

## 확인한 공식 명세

공식 REST OpenAPI 1.2.28의 원문 SHA-256은 `c5918961335ccd6b091577e307dc06ed505b58f83e4d99f0c4617de14ceb036a`로 직전 확인본과 같다. GET /api/v1/orders, GET /api/v1/orders/{orderId}, AccountSeq/OrderId parameter, Order/OrderExecution/OrderStatus/PaginatedOrderResponse를 직접 확인했다. 공식 200 예제 목록 3개·상세 3개만 테스트 fixture로 추출했다. overview의 ORDER_HISTORY 초당 5회도 다시 확인했다. 인증·계좌·주문 API 호출 없이 공개 문서 GET만 수행했다. [공식 OpenAPI](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json), [연동 개요](https://openapi.tossinvest.com/openapi-docs/overview.md)

| 기능        | 공식 동작                                                               | 구현 영향                                                                |
| ----------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| OPEN 목록   | 진행 중 그룹 전량, limit/cursor 무시, from/to는 KST 주문 생성일         | 내부 포트는 OPEN에 limit/cursor를 받지 않고 잘못된 입력을 인증 전에 거부 |
| CLOSED 목록 | 기본 20/최대 100·cursor·KST from/to 적용                                | 단일 페이지만 반환. 후속 cursor를 호출자가 명시적으로 선택               |
| 상태        | CLOSED에도 PARTIAL_FILLED 가능. 취소/정정 거부는 별도 레코드            | 목록 그룹을 terminal/체결 완료로 변환하지 않음                           |
| 미지 코드   | status/orderType/timeInForce는 unknown code 허용                        | 값과 known=false를 보존. 상태 전이/청산/재전송을 승인하지 않음           |
| 체결        | 수량·평균가·금액·수수료·세금·최종 체결 시각은 누적 값                   | 문자열/nullable 유지. 개별 체결 이벤트로 변환하거나 다시 합산하지 않음   |
| 조회 범위   | API가 지원하는 호가 유형만 조회. 일부 시간외 주문은 목록·상세 모두 제외 | 전 계좌 주문 전수/완전 대사 완료로 주장하지 않음                         |

## 인터페이스와 연결

[공통 포트](../packages/broker/src/orders.ts)의 BrokerOrderLookup은 `getOrders(account, query)`와 `getOrder(account, reference)`만 제공한다. 기존 ReadonlyBroker에 필수 메서드를 추가하지 않아 다른 broker·가짜 구현의 호환성을 유지한다. Toss adapter의 반환 타입에 이 capability만 교차 타입으로 추가했다. worker/API/HTTP/CLI에는 호출 경로를 연결하지 않았다.

목록 query는 group=OPEN/CLOSED와 선택적 symbol/from/to다. CLOSED에만 cursor/limit을 허용한다. 심볼은 대문자로 정규화하고 날짜는 유효한 YYYY-MM-DD·from≤to를 검사한다. 계좌는 기존 숫자 reference 검증 후 X-Tossinvest-Account 헤더로만 전송한다. opaque 주문 ID는 제어 문자/빈 값/dot 경로를 거부하고 encodeURIComponent로 단일 경로 조각에 담는다. transport도 동적 경로의 정규 인코딩과 URL 정규화 결과를 인증 전에 검사한다.

[외부 DTO](../packages/broker/src/toss/orders.ts)는 adapter 안에만 둔다. BrokerOrder는 reference·instrument·side·type/validity/status의 code/known·currency·요청량/선택적 가격/금액·시각·누적 execution만 노출하는 내부 서버 모델이다. 계좌/인증/원본 추가 필드를 제거한다. 주문 reference 자체도 비공개 식별자이므로 이 모델을 브라우저 DTO/일반 로그로 바로 내보내지 않는다.

Toss 응답에 별도 market 필드가 없어 지원 통화 KRW/USD로 KR/US를 정규화한다. 숫자·수량·가격·금액·비용은 원래 십진 문자열을 보존한다. 응답 시각은 같은 instant의 UTC ISO로 정규화하며 목록 날짜 필터는 US도 KST로 검사한다. 선택적 price/orderAmount/canceledAt의 누락은 필드 부재로, 명시적 null은 null로 남긴다. execution의 필수 nullable 항목은 누락 시 거부한다. null 비용/평균가/정산일을 0이나 정산 완료로 바꾸지 않는다.

목록의 ID 중복·cursor/hasNext 모순·OPEN의 다음 페이지·CLOSED의 limit 초과·symbol/KST 날짜 불일치는 전체 응답을 거부하고 조용히 잘라내거나 합치지 않는다. OPEN은 로컬 보호 상한 10,000건, ID 512자·심볼 40자·코드 64자·cursor 4,096자·십진 30자를 적용한다. 이는 앱 자원/입력 제한이며 증권사의 추가 보장으로 주장하지 않는다. 상한을 넘으면 실패이며 완전 조회로 표시하지 않는다.

목록/상세는 **동일 broker 인스턴스의 기존 transport/token manager**를 공유한다. 새 발급기·토큰 저장·별도 client 연결은 만들지 않는다. ORDER_HISTORY 5TPS 초기 제한, 서버 rate-limit header, GET 재시도 상한·401 처리·timeout/취소·redirect:error·고정 오류를 재사용한다. 실제 사용은 기존 worker의 client별 DB advisory lock 안에서 해야 하며 이 모듈이 잠금 없이 별도 broker를 시작하는 CLI는 제공하지 않는다.

## 대사·실행 기능과의 경계

- 이 기능은 누적 주문 snapshot 조회만 구현했다. 주문 상태 머신·증분 체결 적용·현금/포지션/원가 갱신·DB 저장·ownership 할당은 아직 없다.
- 응답에 전략/내부 의도·clientOrderId의 연결을 가정하지 않는다. 수동/다른 채널 주문을 자동매매 소유로 편입하지 않는다. 주문 ID를 모르는 불확실 응답을 종목/시각/수량으로 추정 매칭하거나 새 주문으로 재전송하지 않는다.
- 상세에도 개별 체결 ID/체결별 배열을 추측해 추가하지 않았다. 평균가×수량으로 체결 금액을 재계산하거나 평균가를 개별 체결가로 쓰지 않는다. 통화별 누적량/금액/비용과 중복/역행/누락 검증은 후속 대사 로직에서 별도로 다뤄야 한다.
- 주문 목록에는 읽는 동안의 변화·페이징 경합이 있을 수 있다. 단일 페이지·OPEN 목록·404 또는 지원 범위 밖의 주문 부재가 원장 정합성·기존 주문 소멸·재전송 권한을 증명하지 않는다.
- 알려진 상태도 거래 권한은 아니다. UNKNOWN·부분 체결·정산 null·정정/취소 거부를 FILLED/안전 완료로 승격하지 않는다. live 설정을 허용하거나 실제 주문 endpoint/요청 메서드를 추가하지 않는다.

다음 구현은 이 snapshot의 전후 누적량을 **순수 함수로 대조하는 체결 대사**다. 동일 reference/통화/종목 연결·중복 snapshot·부분 체결 증가·누적 비용 정정/누락·역행을 검증하고, 검토 결과만 반환하는 단계부터 시작한다. 실제 주문 생성과 원장 반영은 별도 작업이다.

## 검증

공식 예제·KR/US·부분 체결·CLOSED/PARTIAL_FILLED·unknown 코드·nullable/선택 필드·고정밀 십진·KST 날짜·opaque ID/cursor 인코딩, 입력 인증 전 거부·페이지 정합성·원문 비노출·기존 token/limiter 재사용·실패 재시도/취소를 주입한 가짜 fetch로 검사한다. 이 테스트는 실제 broker·계좌·토큰·주문 API를 호출하지 않는다. 새 라이브러리·스키마 마이그레이션·서비스는 없다.

## 최종 로컬 검증

주문 조회 전용 가짜 fetch 테스트 64개와 전체 verify:ci 141파일·1,374개 테스트(테스트 구간 89.76초)가 통과했다. 최종 전체 검사는 새 일회용 localhost 전용 hth_readonly_test DB에서 기본 병렬 설정으로 실행했으며 포맷·린트·타입·전체 빌드·두 Compose 설정·문서 링크·diff 검사도 통과했다. 원격 CI/실연결/실제 체결 대사 검증을 의미하지 않는다. 실제 계좌·키·DB·원본 예약은 사용하지 않았다.
