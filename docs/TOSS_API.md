# 토스증권 공식 API 확인 기록

확인일: 2026-10-27. 공개 문서만 조회했으며 키 발급·토큰 발급·계좌 조회·주문 요청은 수행하지 않았다.

## 원문과 검증 방식

- [공식 문서](https://developers.tossinvest.com/docs)
- [AI 문서 색인](https://developers.tossinvest.com/llms.txt)
- [연동 개요](https://openapi.tossinvest.com/openapi-docs/overview.md)
- [공식 REST OpenAPI JSON](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json): version `1.2.24`
- [공식 WebSocket AsyncAPI JSON](https://openapi.tossinvest.com/openapi-docs/latest/asyncapi.json): version `1.2.2`
- [공식 FAQ](https://openapi.tossinvest.com/openapi-docs/faq.md)

색인이 지정하는 canonical JSON과 FAQ를 직접 내려받아 확인했다. `/latest/`는 변경될 수 있으므로 adapter 구현 전에 재검증한다. 내려받은 원본의 SHA-256은 REST `7e753c21dc4b938d8f9610ce3efd6542783018977cb030e39db5a006f5b59d40`, WS `130251057fd9535a3e276099f9166b445f8c51f505f30540758e4b209231282e`다. 원본 전체를 저장소에 복제하거나 DTO를 임의로 생성하지 않았다.

읽기 전용 adapter 구현 시 REST를 다시 내려받았다. version은 `1.2.24`, SHA-256은 `7ac6499fc43fda9e8aedb05900758e8251ce2038be763d24c7be6e9f5c3e5a6d`다. 동일 version의 `/latest/` 내용도 변경될 수 있다. `packages/broker/test/fixtures.json`에 이 원문의 계좌·보유분·종목·현재가·캔들·환율·KR/US 캘린더 예제를 테스트용으로 추출했다. 구현 DTO는 소비하는 필드의 projection이며, 최신 명세 전체를 자동 생성한 타입은 아니다.

이후 같은 날 사용자 설정으로 `broker:check` 실연결을 확인했다. 처음에는 인증이 `403 access_denied` 및 IP 미허용으로 거부됐고, 사용자의 허용 IP 등록 후 인증과 전체 읽기 전용 조회가 성공했다. 키·토큰·계좌 식별자·잔고·공인 IP·원본 응답은 이 기록에 포함하지 않는다. 주문 생성·정정·취소와 DB 시세 저장은 실행하지 않았으며, 봉 확정 여부는 여전히 미검증이다.

## 지원 범위

| 기능             | 공식 명세에서 확인한 경로·정책                                                                  | 설계 영향                                                                     |
| ---------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| REST 서버        | `https://openapi.tossinvest.com`                                                                | 서버에서만 호출                                                               |
| OAuth2           | `POST /oauth2/token`, Client Credentials, form-urlencoded                                       | 브라우저 redirect OAuth가 아님                                                |
| 만료·재발급      | refresh token 없음, `expires_in` 사용, 새 토큰은 이전 토큰 즉시 무효화                          | worker 단일 token manager; 예시 86400초를 고정 TTL로 가정하지 않음            |
| IP               | WTS Open API 허용 IP 등록, 미등록 시 403                                                        | 고정 출구 IP 필요                                                             |
| 계좌             | `GET /api/v1/accounts`, 현재 BROKERAGE만, 자녀계좌 불가                                         | 실제 계좌 권한은 연결 시 확인                                                 |
| 보유분           | `GET /api/v1/holdings`, KR/US                                                                   | 계좌 컨텍스트에 `X-Tossinvest-Account` 사용; accounts 목록 조회는 토큰만 필요 |
| 종목             | `GET /api/v1/stocks`                                                                            | KR/US 심볼·통화·정지 여부를 정규화                                            |
| 현재가·호가·체결 | `GET /api/v1/prices`, `/orderbook`, `/trades`                                                   | 최근 체결 최대 50, 전체 체결 내역 대용 아님                                   |
| 캔들             | `GET /api/v1/candles`, `1m`·`1d`, 최대 200, 최신순, `before` inclusive/`nextBefore`, `adjusted` | 봉 확정·정렬·중복 제거·revision 필요                                          |
| 캘린더           | `GET /api/v1/market-calendar/KR`, `/US`, 기준일 조회                                            | 응답 세션·휴장과 DST 처리; 시각은 KST, US 기준 날짜는 미국 현지               |
| 환율             | `GET /api/v1/exchange-rate`                                                                     | 환산 평가와 주문 통화 분리                                                    |
| 주문 생성        | `POST /api/v1/orders`                                                                           | 이번 세션 구현·호출 금지                                                      |
| 정정·취소        | `POST /api/v1/orders/{orderId}/modify`, `/cancel`                                               | 미국 정정은 가격만, quantity 제공 불가                                        |
| 주문 조회        | `GET /api/v1/orders`, `/api/v1/orders/{orderId}`                                                | OPEN 전량, CLOSED 최대 100과 cursor; 누적 체결 기준                           |
| 주문 보조        | `GET /api/v1/buying-power`, `/sellable-quantity`, `/commissions`                                | 현금·소유수량·비용 확인; 자동환전 미지원                                      |
| 멱등성           | `clientOrderId` 동일 본문에 10분, 처리중 409, 다른 본문 422                                     | DB 영구 중복 방지 필요, 10분 후 재전송은 새 주문 가능                         |
| WebSocket        | `wss://openapi-ws.tossinvest.com/ws/v1`                                                         | Bearer handshake·동일 IP 제한, worker에서 연결                                |
| WS 채널          | `trade:kr/us`, `orderbook:kr/us`, `personal:order`                                              | 주문 구독 codes는 종목이 아닌 accountSeq                                      |
| 모의투자         | 확인한 OpenAPI servers에는 production만 있고 sandbox/Paper 명세를 찾지 못함                     | 미지원이라고 단정하지 않음; 자체 Paper로 설계, 추가 지원은 증권사 확인 필요   |

### 데이터 제약 — FAQ 기준

국내 데이터는 KRX+NXT 통합이며 거래소 지정 조회가 불가능하다. 미국 호가·분봉·실시간 데이터는 일부 거래소 기준으로 NBBO가 아니다. 분봉과 일봉의 거래량 집계 범위가 달라 분봉 합으로 일봉을 복원할 수 없다. 상장폐지 종목은 조회할 수 없어 백테스트의 생존편향이 발생한다.

1분봉 제공 시작은 국내 2022-11-23, 미국 2021-12-01이며 일봉에는 이 기간 제한이 적용되지 않는다. `1m` timestamp는 봉 종료 시각, `1d`는 해당 거래일 현지 자정의 KST 표현이다. 미국 1분봉은 늦은 체결로 과거 값이 바뀔 수 있다. 수정주가 제공 이전 구간은 adjusted=false로도 원시 가격을 보장하지 않는다. 미국 소규모 배당락 등이 모두 조정된다고 가정하지 않는다.

### Rate Limits — 연동 개요 기준

단위는 client × 그룹 TPS이며 고정 보장값이 아니다. 정상 응답과 429의 `X-RateLimit-Limit`, `Remaining`, `Reset`을 사용하고 429의 `Retry-After`를 따른다.

| 주요 그룹                                     | 문서상 TPS  |
| --------------------------------------------- | ----------- |
| AUTH / ACCOUNT / ASSET                        | 5 / 1 / 5   |
| STOCK / STOCK_ALL                             | 5 / 1       |
| MARKET_INFO / MARKET_DATA / MARKET_DATA_CHART | 3 / 15 / 20 |
| ORDER / ORDER_HISTORY / ORDER_INFO            | 10 / 5 / 6  |

ORDER_INFO는 09:00–09:10 KST에 3 TPS다. 조회에 지수 백오프·jitter·시도 횟수 상한을 적용하고 거래 요청은 불확실성 정책을 우선한다. 인증 오류는 일반 API 오류 envelope와 달리 OAuth2 형식이므로 별도 파싱한다. 일반 오류는 `error.code`, `error.requestId`를 사용하며 401/403/409/422/429/5xx를 의미별로 분류한다.

### WebSocket 제약 — AsyncAPI 기준

계정당 동시 연결 2개, 연결당 채널×codes 합산 구독 100개, 선언 초당 5회다. 구독은 전체 교체 배열이며 재연결 후 다시 선언한다. 클라이언트 송신이 180초 없으면 종료되므로 60초 PING이 권장된다. 최초 10/27 기록은 연결 중 토큰 만료와 기존 연결 종료를 분리했으나, 이 설명은 최신 정책으로 사용하지 않는다. 2026-11-09 재확인한 AsyncAPI 1.2.3은 만료/무효화 시 auth-revoked 후 연결 종료를 명시한다. 새 handshake에도 유효 토큰이 필요하며 상세 근거는 아래 최신 확인 절을 따른다.

시세는 손실 가능하고 sequence가 없으므로 REST 보정이 필요하다. 주문 이벤트의 무손실 보장은 연결 세션 내부뿐이다. 재연결 구간의 재전송은 없으므로 REST 주문 조회로 대사한다. 주문 이벤트 소비가 2초 이상 막히면 연결이 종료될 수 있어 처리와 수신을 분리한다.

### 운영 전 추가 확인

실제 계정의 Open API 사용 권한·약관·고정 IP, 시세 이용 권한, 세션별 주문 가능 조건, 종목별 거래 제약을 읽기 전용 연결 단계에서 확인한다. FAQ는 제공 정보를 본인 매매에 한해 사용하고 제3자 배포를 금지한다고 명시한다. 대시보드는 소유자 전용으로 운영한다. 문서 확인은 실제 계좌 연결 성공이나 운영 승인 완료를 뜻하지 않는다.

## 2026-11-02 과거 일봉 연구 전 재확인

공식 `/latest/openapi.json`을 재조회한 버전은 `1.2.28`, SHA-256은 `18fdc96fdf632e4869c765ed0cb169049c5310a1c48e10b40e47a71f52aa7a45`다. 기존 adapter가 사용하는 종목·캔들·미국 캘린더 경로와 요청/응답 projection을 재확인했고 공식 200 응답 예제 9개가 현재 DTO 검증을 통과했다. 이 검사는 해당 읽기 전용 범위의 예제 호환성 확인이며 전체 API 변경 분석이나 실연결 승인을 대신하지 않는다. 새 endpoint/DTO·주문 기능은 추가하지 않았다.

같은 날 FAQ의 미국 일봉 OHLC 정규장 기준, 거래량 집계 차이, 과거 수정주가·상장폐지 누락·일부 거래소 원천의 제약을 재확인했다. 연구는 `adjusted=false`를 명시하지만 과거 원 가격/point-in-time 정확성을 보장한다고 해석하지 않는다. 원본 문서는 private 임시 파일로만 확인하고 실제 시세/인증 응답을 이 문서에 복제하지 않았다.

## 2026-11-05 과거 입력 확대 전 재확인

공식 REST OpenAPI를 다시 내려받은 버전은 `1.2.28`, SHA-256은 `c5918961335ccd6b091577e307dc06ed505b58f83e4d99f0c4617de14ceb036a`다. 11/2 보관본과 종목·캔들·국내/미국 캘린더·토큰 경로 및 이들이 참조하는 schema 31개가 같음을 확인했다. 확인한 읽기 전용 범위의 호환성 검사이며 전체 API 변경 검증은 아니다.

[공식 FAQ](https://openapi.tossinvest.com/openapi-docs/faq.md)에서 미국 일봉 OHLC의 정규장 기준, 국내 1분봉의 0거래량 채움·늦게 변할 수 있는 마지막 봉, 미국 sparse 분봉, 수정주가·상장폐지·재배포 제약을 재확인했다. 기존 adapter endpoint/DTO와 종료 판정·완전성 정책을 유지한다. 계좌·보유분·주문 API를 과거 수집에 사용하지 않는다.

## 2026-11-06 현재 수수료 읽기 전용 조회

공식 OpenAPI version 1.2.28·SHA-256 `c5918961335ccd6b091577e307dc06ed505b58f83e4d99f0c4617de14ceb036a`를 다시 확인했다. GET /api/v1/commissions는 ORDER_INFO 그룹과 계좌 헤더를 사용하며 현재 계좌의 marketCountry·소수 비율 commissionRate·선택적 nullable startDate/endDate를 반환한다. 기간은 KST 기준이고 종목/매수·매도 구분/과거 기준일 query는 없다.

기존 transport의 GET 전용 경로 목록에 이 조회만 추가했다. 기존 ReadonlyBroker 포트에 필수 메서드를 늘리지 않고 별도 BrokerCommissionLookup capability로 제공한다. 실제 주문 경로는 추가하지 않았다. 상세 구현·검증과 현행 요율을 과거/실제 청구 검증으로 확대하지 않는 경계는 [수수료 검토](COMMISSION_REVIEW.md)를 따른다.

## 2026-11-09 장기 과거 입력 수집 전 재확인

[공식 원문과 종목 조사](TOSS_RESEARCH_API_2026_11_09.md)를 따른다. REST는 version 1.2.28·SHA-256 `c5918961335ccd6b091577e307dc06ed505b58f83e4d99f0c4617de14ceb036a`로 11/6 원문과 전체 바이트가 같았다. KO/JPM 과거 일봉은 기존 종목·캔들·미국 캘린더·인증 projection으로 수집하며 새 endpoint/DTO를 추가하지 않는다.

현재 공식 AsyncAPI는 1.2.3·SHA-256 `46669a360d4c5c6485c157624825e599f5dc55f8b9f66b9b3bcf3bfc3b9e7512`다. 연결 중 토큰 재검증과 만료·재발급 등 무효화 시 auth-revoked 후 종료를 명시하며 최신 overview와 일치한다. 이전 1.2.2 기반의 만료 후 연결 지속 설명을 현재 설계 가정으로 사용하지 않는다. 고정 TTL 숫자나 실제 서버의 만료 동작은 이번 공개 문서 조사로 검증되지 않았다. 실제 WS 연결/자연 갱신 검증을 대신하지 않으며 이번 REST 수집을 WS 수명 검증으로 확대하지 않는다.

## 2026-11-10 구실행 권한 폐기 설계의 공개 명세 확인

REST 1.2.28 원문 SHA-256은 `c5918961335ccd6b091577e307dc06ed505b58f83e4d99f0c4617de14ceb036a`, AsyncAPI 원문은 `46669a360d4c5c6485c157624825e599f5dc55f8b9f66b9b3bcf3bfc3b9e7512`로 직전 확인본과 같았다. 공개 Auth operation은 POST /oauth2/token만 확인했다. 토큰 재발급에 의한 이전 토큰 무효화와 구 client 자격의 발급 권한 폐기를 구분한다. [공식 OpenAPI](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json)

[FAQ](https://openapi.tossinvest.com/openapi-docs/faq.md)는 WTS 키 재발급을 설명하지만, 그 조작이 모든 기존 토큰/연결과 재발급 경로를 언제/어떤 범위로 차단하는지는 이번 확인으로 확정하지 않았다. overview/AsyncAPI의 연결 중 무효화 설명을 REST client 전체 회수의 보장으로 확대하지 않는다. 확인 범위에서 회수 operation을 발견하지 못했다는 뜻이며 WTS 관리 기능이 없다는 결론은 아니다.

FAQ SHA-256은 `6ad4c02b8e785f7de1a067398736e69b546069f8d1e74d89e294a1a774c1a1da`, overview는 `bef057d9babe9a389b78c430e7dfeaa6859cb09adf0e1906c3728a57c8972204`다. 원문은 메모리에서 조회했고 인증/키 재발급/토큰·시세·계좌 API를 호출하지 않았다. [권한 폐기 설계안](PAPER_AUTHORITY_FENCING_DESIGN.md)의 provider-fence 근거는 아직 미검증이며 새 endpoint/DTO·회수 명령·실제 주문 기능을 추가하지 않는다.

## 2026-11-11 주문 목록·상세 읽기 전용 구현 전 확인

REST 1.2.28의 원문 SHA-256은 `c5918961335ccd6b091577e307dc06ed505b58f83e4d99f0c4617de14ceb036a`로 동일하다. GET /api/v1/orders와 GET /api/v1/orders/{orderId}의 query/header·Order/OrderExecution/OrderStatus/PaginatedOrderResponse·공식 200 예제 6개를 확인했다. OPEN은 전량/limit·cursor 무시, CLOSED는 기본 20/최대 100·cursor와 KST 생성일 필터이며 CLOSED에도 PARTIAL_FILLED가 포함된다. status/orderType/timeInForce의 미지 코드는 보존한다. 실제 주문 API를 호출하거나 생성/정정/취소를 구현하지 않았다. 조회 범위와 대사 미구현 경계는 [주문 읽기 전용 연동](ORDER_READONLY.md)을 따른다.
