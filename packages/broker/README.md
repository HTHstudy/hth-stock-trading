# Broker

증권사와 분리된 읽기 전용 port 및 `@hth/broker/toss` adapter를 제공한다. 주문 생성·정정·취소와 Paper 체결은 구현하지 않는다. 이 인터페이스는 토스 DTO를 그대로 재현한 것이 아니다.

`src/toss`에 입력 검증, Zod 응답 projection, mapper, 단일 갱신 token manager, 그룹별 limiter, 조회 재시도·취소·타임아웃을 구현했다. 토큰은 메모리에만 보관한다. 허용한 고정 HTTPS 서버로만 통신하며 redirect를 따라가지 않는다. HTTP transport는 외부로 공개하지 않고 조회 메서드만 공개한다.

DTO는 실제 사용하는 필드를 검증하는 projection이다. 나머지 필드는 제거하며 전체 OpenAPI 응답 검증이라고 주장하지 않는다. 알 수 없는 계좌 유형은 문자열로 보존하고, 현재 도메인에서 취급할 수 없는 통화·시장은 안전하게 거부한다. 계좌번호는 반환하지 않는다. 오류는 정해진 코드·HTTP status·제한된 request ID만 포함하고 upstream body·URL·인증 정보를 노출하지 않는다. `BrokerError`는 안전한 오류 식별을 위한 Error 하위 클래스다.

토큰 발급은 재시도하지 않으며 GET의 일시적 장애는 최대 3회 시도한다. 401 재발급은 1회, 403·입력·응답 오류는 재시도하지 않는다. `Retry-After`와 `X-RateLimit-*`를 반영하고 30초를 넘는 대기는 조기 재시도 대신 실패한다. 호출별 기본 타임아웃은 응답 본문 읽기를 포함해 5초다. 인증 갱신은 같은 adapter 인스턴스 내 single-flight이고, 다중 프로세스 조정은 worker의 DB lease가 담당한다.

시세의 timestamp 미제공은 null로 보존한다. 시장 일정은 휴장 null과 미제공을 `sessionsKnown`으로 구분한다. 캔들은 UTC 오름차순·중복 제거·정확한 십진 OHLC 비교를 수행한다. 캔들 확정 정책은 아직 없으므로 모두 `isClosed=false`이며 전략 실행에 사용하면 안 된다. 미국 분봉 거래일은 뉴욕 시각 20시 경계와 봉 종료 시각을 함께 처리한다.

`test/fixtures.json`은 2026-10-27 공식 OpenAPI 1.2.24의 성공 응답 예제를 추출한 테스트 데이터다. buyingPower는 공식 schema의 예시값으로 만든 합성 응답이며, USD 및 장애·누락·경계 시나리오는 테스트에서 변형한다. 실제 키·계좌 응답을 저장하지 않는다. 모든 broker 테스트는 fetch를 주입하여 실제 네트워크 호출을 하지 않는다.
