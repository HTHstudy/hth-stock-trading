# 읽기 전용 매도 가능 수량

2026-11-17 [공식 OpenAPI](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json)의 getSellableQuantity/SellableQuantityResponse를 확인해 구현했다. 실제 계좌 호출·주문/정정/취소는 실행하지 않았다. 원문 version/hash는 [전송 계약](ORDER_TRANSPORT_DESIGN.md)에 기록한다.

- `BrokerSellableQuantityLookup`은 선택 capability다. 기존 ReadonlyBroker 구현/가짜 포트에 필수 메서드를 추가하지 않았다.
- Toss adapter의 getSellableQuantity(account, instrument)는 기존 transport/token manager로 GET /api/v1/sellable-quantity를 호출한다. query는 정규화 symbol, 계좌는 X-Tossinvest-Account 헤더다. 새 발급기/연결/worker/API/CLI를 만들지 않았다.
- ORDER_INFO 슬롯/응답 한도 헤더와 기존 GET의 제한 재시도·취소·timeout·redirect:error를 재사용한다. 실제 연결 시 기존 worker/client advisory lock을 유지해야 한다. 이 재시도를 향후 POST에 사용하지 않는다.
- 공식 결과의 sellableQuantity 문자열을 그대로 보존하며 number 변환/반올림하지 않는다. KR은 6자리 영숫자 종목 문맥과 정수값 수량만 허용하고 US 소수 수량은 보존한다. 이는 조회 validation이며 소수점 주문을 지원한다는 뜻이 아니다.
- 부정/누락/null/숫자형/과도한 길이·잘못된 문맥은 고정 오류로 거부한다. 원본 부가 필드는 제거하고 응답/계좌/토큰/원문 오류를 로그에 남기지 않는다.

DTO는 adapter 내부 projection이다. 결과는 `{instrument,quantity}`이며 instrument는 **검증된 호출 문맥**이다. 서버 응답에 종목/시장이 없으므로 이 값 자체로 시장/계좌/전략 소유권을 인증하지 않는다. 호출자는 별도로 확인한 종목과 계좌를 사용해야 한다.

브로커의 판매 가능량이 많아도 수동/다른 전략의 주식을 팔 수 없다. 내부 소유량·미예약 수량·계좌/전략/한도·최신 시장 데이터와 실제 자원 검사를 같은 운용 절차에서 확인해야 한다. 조회 결과/성공은 canSell·ownershipVerified·실행/재개 권한을 생성하지 않는다. 현재 위험/실행/합성 원장에는 이 조회를 자동 연결하지 않았다.

공식 예제 형태·KR/US·고정밀/0 수량·정수 표현·응답 오염·잘못된 입력의 인증 전 차단·token/한도 공유·429 GET 재시도·권한 부재를 가짜 fetch 23개 테스트로 검사했다. 주문 조회/수수료 기존 검사 포함 관련 146개가 통과했다. 새 라이브러리·DB/마이그레이션·운용 옵션은 없다.

최종 로컬 `verify:ci`는 새 일회용 localhost 전용 DB에서 **155파일·1,668개 테스트**를 통과했다(테스트 구간 104.98초). 포맷·린트·타입·전체 빌드·두 Compose 설정·문서 링크/diff도 통과했다. 원격 Actions/실연결 결과가 아니며 테스트 DB 외 사용자 데이터/마이그레이션을 실행하지 않았다.
