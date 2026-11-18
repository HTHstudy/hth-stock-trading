# 기본 비활성 주문 writer

2026-11-18. 사용자 승인 범위는 주문 연동 코드 구현이다. 실제 생성·정정·취소 호출, live 활성화·배포·사용자 DB 마이그레이션은 수행하지 않는다. 기존 전역 `live` 설정 거부와 Paper 경계는 유지한다. 새 의존성·환경변수·HTTP/CLI 실행 경로·DB 스키마는 없다.

## 공개 API와 격리

`@hth/broker`의 `createTossOrderWriter()`는 인자 없이 항상 `mode=disabled`, `executionEnabled=false`를 반환한다. `submitOrder`는 입력·키·토큰·네트워크를 읽기 전에 `ORDER_EXECUTION_DISABLED`로 거부한다. 기존 production transport도 POST를 인증 전에 거부한다. 키나 임의 옵션으로 열리지 않는다.

`@hth/broker/testing`의 `createTossOrderMockSession`만 주입한 가짜 fetch를 사용해 요청/응답 코드를 검증한다. fetch 누락·직접 전달한 global fetch는 거부하며 주소는 `https://toss-writer.invalid`로 고정한다. 임의 baseUrl은 사용하지 않는다. 주입 함수 자체는 신뢰된 테스트 코드이며, 악의적인 callback의 외부 I/O까지 격리하는 sandbox라는 뜻은 아니다. 실제 자격을 전달하지 않는다.

mock session의 readonly/writer는 하나의 transport/token manager와 그룹별 rate limiter를 공유한다. API 서버나 별도 인스턴스의 독립 토큰 발급을 추가하지 않는다. production 읽기 전용 broker의 기존 공개 capability와 GET 재시도 정책은 유지한다.

## 제한 profile과 정규화

`BrokerLimitOrderRequest`의 `limit-day-integer-v1`만 지원한다. 호출자가 생성한 UUID clientOrderId, KR/US instrument, BUY/SELL, 양의 정수 문자열 quantity, 양의 십진 문자열 limitPrice를 strict schema로 검증한다. KR은 6자리 영숫자 symbol과 정수 원 가격만 받는다. US는 1달러 미만 4자리, 이상 2자리 소수까지 받는다. 호가 단위/상품·거래 장소 적합성·최대 투자금/전략 소유권은 이 검증으로 보장되지 않는다.

`normalizeTossLimitOrderRequest`는 UUID 소문자·symbol 대문자, 수량/가격 선행 0과 소수 후행 0만 정리하고 원본을 변경하지 않는다. 0이 아닌 초과 정밀도는 절삭 없이 거부한다. 실제용 의도/hash를 저장할 때는 **정규화한 뒤** 고정해야 한다. adapter는 key를 새로 생성하지 않는다.

직렬화는 공식 POST `/api/v1/orders`의 수량 요청으로 제한한다. `orderType=LIMIT`, `timeInForce=DAY`, `confirmHighValueOrder=false`를 고정한다. 시장가·금액 주문·소수 수량·조건/정정/취소는 미구현이다. 공식 사실과 선택한 클라이언트 정책은 [전송 계약](ORDER_TRANSPORT_DESIGN.md)을 따른다.

## 한 번의 전송과 결과

POST는 GET 재시도 루프와 분리한다. 인증/한도 대기 중 취소처럼 fetch 호출 전 실패는 `not-sent`, fetch 호출 이후 timeout·취소·네트워크/JSON 오류는 `unknown`이다. 401/429/5xx를 포함한 비정상 응답에 주문을 재전송하거나 401 토큰 갱신 후 다시 보내지 않는다. 그룹 ORDER는 초기 10TPS, 응답 헤더를 반영한 간격을 적용한다.

200 응답은 유효한 orderId와 **요청과 같은 clientOrderId echo**가 있을 때만 `acknowledged`다. 명세상 echo가 nullable/선택적이어도 이 profile에서는 없거나 다르면 `unknown`으로 남긴다. 200 접수를 OPEN/FILLED·체결/현금 변화로 해석하지 않는다. 다른 상태/불완전 응답도 이 단계에서는 확정 거부로 단정하지 않는다.

모든 결과는 불변이며 `mode=mock`, `executionEnabled/ownershipVerified/canApplyToLedger/canResend=false`를 포함한다. 오류는 고정 코드와 HTTP status만 반환하고 원문·계좌·토큰·요청 ID를 전달하지 않는다. 반환 order reference/client key는 내부 mock 결과이며 브라우저 DTO가 아니다.

## 테스트 세션의 중복 억제 한계

세션 내 client key와 정규화 계좌/요청을 묶고 동시 중복은 하나의 Promise를 공유한다. 같은 요청은 이전 결과를 재사용하고 계좌/요청 변경은 `ORDER_ATTEMPT_CONFLICT`다. 실패 결과도 재사용하며 10분이 지나도 재전송하지 않는다. 세션당 256개까지 기억하고 이후 새 key는 `ORDER_ATTEMPT_LIMIT`로 거부한다. 기존 key는 만료/삭제하지 않는다.

이 메모리 구조는 재시작 후 영구 중복 방지, 다중 프로세스 소유권 또는 DB 전송 허가가 아니다. 실제 worker에 연결하지 않으며, 공식 10분 멱등만 믿고 실제 주문을 다시 보내는 구현도 아니다.

## 검증과 다음 단계

가짜 통신으로 production 사전 차단, 정확한 요청/header, 가격/수량·추가 필드 거부, echo 누락/불일치, HTTP/JSON/timeout/취소의 불확실성, 동시 중복·요청 변경·10분 이후 재사용·상한, 공유 토큰/한도를 검증한다. 기존 관측은 새 주문 오류를 허용된 관측 실패 코드로만 기록한다.

[주문 시도 영속 기록](ORDER_ATTEMPT_JOURNAL.md)으로 2단계의 의도/attempt·결과 저장과 재접속 후 재전송 금지를 가짜 통신/전용 테스트 DB에서 구현했다. 실제 자원/금융 적용은 여전히 미구현이다. 남은 범위는 [전송 계약](ORDER_TRANSPORT_DESIGN.md)의 2단계를 따른다. 실제용 불변 의도/attempt, 전송 전 커밋·계좌 제어/lease CAS, ACKNOWLEDGED/UNKNOWN 저장, 실제 금융 opening baseline과 첫 누적 체결/비용을 전용 테스트 DB에서 검증한다. 이후 운영 gate/중단·조회 복구와 별도의 제한된 실계좌 실행 승인이 필요하다. 현재 구현을 실거래 가능 상태로 표시하지 않는다.
