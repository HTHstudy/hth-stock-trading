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

계정당 동시 연결 2개, 연결당 채널×codes 합산 구독 100개, 선언 초당 5회다. 구독은 전체 교체 배열이며 재연결 후 다시 선언한다. 클라이언트 송신이 180초 없으면 종료되므로 60초 PING이 권장된다. 연결 중 토큰 만료만으로 연결이 끊기지는 않지만 새 handshake에는 유효 토큰이 필요하다.

시세는 손실 가능하고 sequence가 없으므로 REST 보정이 필요하다. 주문 이벤트의 무손실 보장은 연결 세션 내부뿐이다. 재연결 구간의 재전송은 없으므로 REST 주문 조회로 대사한다. 주문 이벤트 소비가 2초 이상 막히면 연결이 종료될 수 있어 처리와 수신을 분리한다.

### 운영 전 추가 확인

실제 계정의 Open API 사용 권한·약관·고정 IP, 시세 이용 권한, 세션별 주문 가능 조건, 종목별 거래 제약을 읽기 전용 연결 단계에서 확인한다. FAQ는 제공 정보를 본인 매매에 한해 사용하고 제3자 배포를 금지한다고 명시한다. 대시보드는 소유자 전용으로 운영한다. 문서 확인은 실제 계좌 연결 성공이나 운영 승인 완료를 뜻하지 않는다.
