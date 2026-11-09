# KO·JPM 독립 연도 연구용 공식 API 재확인

확인일: 2026-11-09 KST. 공개 공식 문서 다운로드와 저장소 코드 읽기만 수행했다. 실제 broker·키·환경파일·계좌·주문·DB·토큰 API에 접근하지 않았으며 수집·빌드·테스트·커밋을 실행하지 않았다. 저장소에서는 이 새 문서만 작성했다. 본 기록은 자료 조사이며 수집 완료·과거 시점 정확성·수익성·운용 승인이 아니다.

## 원문 URL·버전·hash·보관 위치

[공식 가이드](https://developers.tossinvest.com/docs)는 비 JavaScript 클라이언트에 [공식 색인](https://developers.tossinvest.com/llms.txt)을 안내한다. 아래 URL은 기존 [공식 API 확인 기록](TOSS_API.md)에도 기재된 주소다. 다운로드는 인증 없는 HTTPS GET이며 모두 HTTP 200이었다. SHA-256은 내려받은 원본 바이트 기준이다. 임시 원문 파일은 새로 생성하고 권한을 0600으로 설정했다.

| 원문                                                                                 | 버전                          | 다운로드 시각 UTC / KST        | 바이트 | SHA-256                                                            | private 임시 경로                        |
| ------------------------------------------------------------------------------------ | ----------------------------- | ------------------------------ | ------ | ------------------------------------------------------------------ | ---------------------------------------- |
| [REST OpenAPI JSON](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json) | API `1.2.28`, OpenAPI `3.1.0` | 2026-11-09 00:54:17 / 09:54:17 | 534361 | `c5918961335ccd6b091577e307dc06ed505b58f83e4d99f0c4617de14ceb036a` | `/private/tmp/hth-openapi-20261109.json` |
| [FAQ](https://openapi.tossinvest.com/openapi-docs/faq.md)                            | 본문에 독립 버전 번호 없음    | 2026-11-09 00:54:17 / 09:54:17 | 19799  | `6ad4c02b8e785f7de1a067398736e69b546069f8d1e74d89e294a1a774c1a1da` | `/private/tmp/hth-faq-20261109.md`       |
| [overview](https://openapi.tossinvest.com/openapi-docs/overview.md)                  | 본문에 독립 버전 번호 없음    | 2026-11-09 00:54:17 / 09:54:17 | 31279  | `bef057d9babe9a389b78c430e7dfeaa6859cb09adf0e1906c3728a57c8972204` | `/private/tmp/hth-overview-20261109.md`  |

web 도구에서도 REST JSON과 발행사 원문 링크를 열어 확인했다. FAQ는 web 도구가 `text/markdown`을 처리하지 못했고 overview도 가져오지 못했으므로, 두 본문은 동일한 공식 URL을 표준 HTTPS 클라이언트로 직접 다운로드해 확인했다. 이를 web 표시 성공으로 기록하지 않는다. 최초 조사에서는 AsyncAPI를 제외했으며, 아래 후속 조사에서 공식 원문을 추가 다운로드했다.

## 11월6일 보관본과 비교

비교 원본 `/private/tmp/hth-openapi-20261106.json`은 존재하며 version `1.2.28`, SHA-256 `c5918961335ccd6b091577e307dc06ed505b58f83e4d99f0c4617de14ceb036a`다. 최신 다운로드와 **파일 전체 바이트 및 JSON 구조가 일치**했다. [기존 기록](TOSS_API.md)의 11월5일·6일 REST hash와도 같다. 11월2일 hash와는 다르지만 이번 비교 기준일은 11월6일이다.

아래 path item 전체(설명·파라미터·응답·예제·security 포함)가 모두 일치했다.

| 대상        | 공식 method / path               | 결과                     |
| ----------- | -------------------------------- | ------------------------ |
| 캔들        | `GET /api/v1/candles`            | 변경 없음                |
| 종목        | `GET /api/v1/stocks`             | 변경 없음                |
| 미국 캘린더 | `GET /api/v1/market-calendar/US` | 변경 없음                |
| 토큰 명세   | `POST /oauth2/token`             | 변경 없음; 호출하지 않음 |

위 4개 path item에서 시작해 `$ref`를 재귀 탐색한 참조 25개도 추가·삭제·내용 변경이 없었다. schema는 17개이며 나머지는 parameter 1개·response 7개다. 전역 `servers`, `security`, `oauth2ClientCredentials` security scheme도 같다.

- schemas: `ApiError`, `ApiResponse`, `Candle`, `CandlePageResponse`, `Currency`, `ErrorResponse`, `KrMarketDetail`, `OAuth2ErrorResponse`, `OAuth2TokenRequest`, `OAuth2TokenResponse`, `StockInfo`, `UsAfterMarketSession`, `UsDayMarketSession`, `UsMarketCalendarResponse`, `UsMarketDay`, `UsPreMarketSession`, `UsRegularMarketSession`.
- parameter: `SymbolQuery`.
- responses: `Forbidden`, `InternalErrorMarketData`, `InternalErrorMarketInfo`, `InternalErrorStock`, `NotFound`, `RateLimitExceeded`, `Unauthorized`.

FAQ·overview의 이름에 20261106이 포함된 `hth-*` 임시 보관본은 찾지 못했고, 기존 문서에도 이 두 원문의 기준 hash가 없다. 따라서 두 Markdown 원문의 바이트 변경 유무·변경 시점은 미확인이다. REST 동일성을 FAQ·overview 동일성으로 확대하지 않는다.

### 구체적인 기존 기록과의 상충: WebSocket 토큰 수명

최신 [overview](https://openapi.tossinvest.com/openapi-docs/overview.md)의 `웹소켓 연동 → 연결` 5번은 연결 중 토큰 재검증을 명시한다. 만료·재발급·삭제, 허용 IP 제외 또는 구독 계좌 부적격이면 `auth-revoked` 프레임 후 연결을 닫으며, 만료 전 재발급·재연결을 안내한다. 같은 원문의 오류 표도 이를 반복한다.

이는 [기존 API 기록](TOSS_API.md)의 “연결 중 토큰 만료만으로 연결이 끊기지는 않지만”이라는 설명과 상충한다. **기존 설명을 최신 정책으로 사용하지 않아야 한다.** 최초 조사에서는 overview만 확인했으며 최신 AsyncAPI와의 대조는 아래 후속 조사에 기록한다. 실제 만료 실험·코드 변경은 하지 않았다. REST token path/schema가 11월6일과 같다는 결론과는 별개다.

## 후속 조사: 최신 AsyncAPI와 토큰 수명 문구 대조

2026-11-09 00:58:23 UTC / 09:58:23 KST에 [공식 latest AsyncAPI JSON](https://openapi.tossinvest.com/openapi-docs/latest/asyncapi.json)을 인증 없는 HTTPS GET으로 다운로드했다. HTTP 200, `application/json`, 65344바이트이며, AsyncAPI 형식 버전은 `3.0.0`, `info.version`은 `1.2.3`이다. REST 명세 버전과 독립적으로 관리된다는 설명도 원문에 있다.

- 원문 보관: `/private/tmp/hth-asyncapi-20261109.json`, 새 파일 권한 0600.
- 원본 바이트 SHA-256: `46669a360d4c5c6485c157624825e599f5dc55f8b9f66b9b3bcf3bfc3b9e7512`.
- 기존 `TOSS_API.md`의 AsyncAPI 기록은 `1.2.2`, hash `130251057fd9535a3e276099f9166b445f8c51f505f30540758e4b209231282e`다. 현재 버전·hash와 다르다. 이 비교는 기존 문서 기록 기준이며 구판 JSON 전체의 구조적 차이를 검사한 것은 아니다.
- 00:58:36 UTC / 09:58:36 KST에 overview도 공식 URL로 다시 GET했다. HTTP 200이고 앞서 저장한 원문과 바이트가 동일했다. SHA-256은 위 표의 `bef057d9babe9a389b78c430e7dfeaa6859cb09adf0e1906c3728a57c8972204` 그대로다.
- web 도구로 두 URL 열기도 시도했지만 접근 실패했다. 이 후속 대조의 근거는 표준 HTTPS 클라이언트로 받은 공식 원본이며 web 표시 성공이나 WS 접속 성공을 뜻하지 않는다.

| 항목                   | 최신 AsyncAPI 원문 위치·내용                                                                                                                                                     | overview 대조 결과                                                              |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 연결 중 토큰 검증·만료 | JSON Pointer `/channels/connection/description`은 “연결 유지 중에도 서버가 토큰을 재검증합니다.” 및 “토큰이 만료되면 연결도 종료되므로”를 명시한다.                              | `웹소켓 연동 → 연결` 5번에 같은 문구가 있다. 문서 간 상충 없음.                 |
| 무효화·종료            | 같은 description은 만료·재발급·삭제·허용 IP 제외·구독 계좌 부적격 시 `auth-revoked` 후 연결 종료를 설명한다.                                                                     | 연결 5번과 `웹소켓 에러 / 거부` 표의 내용이 일치한다.                           |
| 오류 프레임            | `/channels/connection/messages/errorFrame/payload/description`과 `/channels/connection/messages/errorFrame/examples/2`는 `id` 없는 `auth-revoked`와 프레임 직후 종료를 설명한다. | overview의 오류 프레임·코드 표와 일치한다.                                      |
| keepalive              | `/channels/connection/description`의 180초 idle 종료·60초 PING 권장은 클라이언트 송신 공백 기준이다.                                                                             | overview 연결 4번과 일치한다. 토큰 TTL 또는 만료 연장 시간으로 해석하지 않는다. |

**현재 토큰 TTL의 숫자는 확인하지 않았다.** AsyncAPI는 별도 고정 토큰 TTL을 제시하지 않으며, REST `/components/schemas/OAuth2TokenResponse/properties/expires_in`은 남은 초를 설명하고 `86400`을 예시로만 제시한다. 예시를 현재 실제 TTL·고정 24시간 보장으로 사용하지 않는다. 토큰 응답이나 실제 WS 로그인을 조회하지 않았으므로 현재 토큰의 잔여 수명·실제 서버 만료 동작은 미검증이다.

최신 overview와 AsyncAPI는 문서상 일치하며, 기존 `TOSS_API.md`의 만료 후 연결 지속 설명과 상충한다. 이는 **공식 문서 간 일치 확인**이며 실제 운영 정책·서버 동작의 실증 확인은 아니다. 토큰 만료 후에도 연결이 지속된다고 가정하지 않는다. 향후 공식 문서끼리 상충하면 한쪽을 확정 정책으로 선택하지 않고 미검증 상태를 유지한다. 공식 문서의 재발급·재연결 안내는 이번 작업의 실행 지시가 아니며, 진행 중인 REST collector·공유 토큰·잠금·코드·`TOSS_API.md`는 변경하지 않았다. 토큰 발급·키 접근·실제 WebSocket 로그인·빌드·테스트·커밋은 수행하지 않았다.

## 기존 adapter로 확인한 연구 입력·접근 한계

[REST 원문](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json)에서 확인한 범위다. 캔들은 `symbol`, `interval=1d`, `count≤200`, `before`(inclusive), `adjusted`를 사용한다. 최신순이며 후속 조회는 `nextBefore`를 그대로 전달한다. 공식 기본 `adjusted=true`에 의존하지 않고 연구에서는 `false`를 명시한다. 종목은 `symbols` 최대 200개, 미국 캘린더의 `date`는 미국 현지 날짜이고 세션 시각은 KST다.

[overview](https://openapi.tossinvest.com/openapi-docs/overview.md) 기준 시장 데이터는 계좌 헤더 없이 Bearer 토큰으로 조회한다. 허용 IP 등록이 필요하다. client×그룹 TPS는 AUTH 5, STOCK 5, MARKET_INFO 3, MARKET_DATA_CHART 20이며 사전 공지 없이 조정될 수 있다. 일부 IP에는 1 TPS 제한이 가능하다. 실제 한도는 `X-RateLimit-Limit`·`Remaining`·`Reset`, 429 대기는 `Retry-After`를 따른다. 토큰은 client당 하나이고 재발급하면 이전 토큰이 즉시 무효화된다. 이번 작업은 인증을 생성하거나 기존 연결을 변경하지 않았다.

[FAQ](https://openapi.tossinvest.com/openapi-docs/faq.md)의 연구 관련 제약:

- 미국 일봉 OHLC는 정규장 기준이며 종가는 공식 종가다. 거래량은 종합 집계로 시간외 체결을 포함할 수 있다. 분봉 합으로 일봉을 복원하지 않는다.
- 일봉 timestamp는 거래일 현지 자정의 KST 표현이다. 날짜 경계는 뉴욕 시간대로 해석한다.
- 미국 1분봉의 2021-12-01 제공 시작 제한은 일봉에 적용되지 않는다. 이것이 KO/JPM 특정 연도의 실제 가용성·완전성을 보장하지는 않는다.
- 수정주가 제공 시작 이전에는 `adjusted=false`여도 원 가격을 보장하지 않는다. 해당 시작일은 이 FAQ에서 구체적으로 제시하지 않는다. 미국 조정은 기준가 차이가 5%를 초과할 때 적용되어 작은 배당락까지 모두 반영한다고 볼 수 없다.
- 미국 시세는 일부 거래소 원천으로 NBBO가 아니다. 일봉 거래량의 종합 집계 설명과 구분한다. 상장폐지 종목은 조회할 수 없어 생존편향이 남는다.
- 정보 이용은 투자자 본인 매매 목적에 한정되며 비상업적 제3자 배포도 금지된다. 문서 조사는 시세 재배포 권한을 제공하지 않는다.

기존 코드 `packages/broker/src/toss/index.ts`의 `getInstruments`, `getCandles`, `getMarketCalendar`를 읽어 위 경로와 `adjusted` 전달·US 날짜 정규화를 확인했다. `apps/worker/src/historical-collect.ts`는 종목 확인 후 범위 내 모든 날짜의 캘린더를 조회하고, 페이지당 200개 캔들을 읽어 시장 거래일로 필터링한다. cursor 진행·종목 일치·페이지 상한을 검사하고 원본 봉은 미확정으로 처리한다. 이는 코드 읽기 결과이며 DTO 예제 검증이나 실연결 테스트 결과가 아니다. 새 endpoint·DTO는 만들지 않는다.

## 발행사 1차 자료로 확인한 종목·업종

다음 두 원문은 web 도구로 직접 열어 확인했다. 업종은 발행사의 사업 설명을 한국어로 요약한 연구 라벨이며 GICS 등 공식 분류 코드를 검증했다는 뜻이 아니다.

| 연구 심볼 | 정확한 발행사·거래소            | 업종 identification                                                                           | 발행사 공식 원문                                                                                                                            |
| --------- | ------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `KO`      | The Coca-Cola Company, NYSE: KO | 음료. 발행사가 종합 음료 기업으로 소개하며 탄산음료·물·스포츠음료·커피·차·주스 등을 설명한다. | [2026-10-15 발행사 공지의 About The Coca-Cola Company](https://www.coca-colacompany.com/media-center/coca-cola-declares-quarterly-dividend) |
| `JPM`     | JPMorgan Chase & Co., NYSE: JPM | 금융서비스. 발행사가 투자은행·소비자/소기업 금융·상업은행·금융거래 처리·자산관리를 설명한다.  | [2026-01-23 발행사 Company Update 공지](https://www.jpmorganchase.com/ir/news/2026/jpmc-company-update-2026)                                |

이 확인은 발행사·티커·사업 identification이며 Toss의 KO/JPM 실제 조회 응답, 현재 거래 가능 여부 또는 2023~2025년 시세 보유를 확인한 것은 아니다. 현재 사업 설명을 과거 업종 분류의 point-in-time 증거로 사용하지 않는다.

## 신규 연구 계획: 3개 독립 연도, 총 6개 입력

각 행은 KO와 JPM을 **각각 별도 수집·동결·연구 입력**으로 취급하는 계획이다. 모두 `market=US`, `interval=1d`, `adjusted=false`, `source=toss`이며 기존 adapter만 사용한다. 연도 사이 입력·워밍업·성과를 자동 연결하지 않는다.

| 독립 연도 | 미국 현지 from ~ to, 양끝 포함 | 달력 일수 | 개별 입력          |
| --------- | ------------------------------ | --------- | ------------------ |
| 2023      | 2023-01-01 ~ 2023-12-31        | 365       | KO 2023 / JPM 2023 |
| 2024      | 2024-01-01 ~ 2024-12-31        | 366       | KO 2024 / JPM 2024 |
| 2025      | 2025-01-01 ~ 2025-12-31        | 365       | KO 2025 / JPM 2025 |

각 범위는 [과거 데이터 정책](HISTORICAL_DATASETS.md)의 최대 366일을 충족한다. 366일은 API 단일 응답 봉 수 제한이 아니라 저장소의 연구 요청 날짜 상한이다. 실제 거래일 수·봉 개수·커버리지·hash는 수집 전이므로 미확인이다. 기존 수집기는 종목별로 날짜마다 캘린더를 확인하므로 이 계획의 캘린더 조회는 합계 2192회이며, 캔들은 별도 페이지네이션이다. TPS를 처리시간 보장으로 해석하지 않는다.

향후 수집 결과는 각 입력의 관측 시각·캘린더·원본 관측·coverage·dataset hash를 보존하고 `pointInTime=false` 경계를 유지해야 한다. 누락·미완성·cursor 오류·페이지 상한 도달은 추정 보완하지 않는다. 기존 CLI의 dry run도 토큰·인증 잠금 DB를 사용하므로 이번 무키·무DB 조사에서 실행하지 않았다. 이 문서 작성은 수집 시작·예약·재개가 아니다.
