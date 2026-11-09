# 음료·금융 종목으로 확대하는 독립 연도 연구

2026-11-09 KO·JPM의 2023·2024·2025년 미국 일봉 6개 데이터셋을 수집하고, 세 전략과 단순 보유 대조군의 기본·스트레스 비용 48조건을 각각 두 번 실행했다. 수집은 총 1504봉이며 Paper 읽기 전용 capture의 전후 hash가 같았다. 반복 결과·공개 snapshot·기존 리포트 보존은 저장된 검증 기록으로 확인했다. 사후 수집 연구이며 독립 holdout·전략 선정·운용 승인을 제공하지 않는다.

## 근거와 고정 시점

`/private/tmp/hth-current-sector-research.txt`가 가리키는 private 디렉터리의 `protocol.json`을 읽었다. 확인한 파일은 `.local-data/sector-research/bb321f63-db4a-4368-918a-e1fa18b852e0/protocol.json`이다. 원본을 수정하지 않았다.

| 항목                          | 원본에 기록된 값 또는 파일 읽기 결과                               |
| ----------------------------- | ------------------------------------------------------------------ |
| `formatVersion`               | `sector-research-protocol-v1`                                      |
| `fixedAt`                     | `2026-11-09T00:56:26.920Z` / 2026-11-09 09:56:26.920 KST           |
| 내장 `hash`                   | `399f6520bca34fcbe72da4506b30ae6cc1f9f8eb5aa76a39d36935b063975a2a` |
| 읽은 파일 전체 바이트 SHA-256 | `c96daad1cce0db93cbb5f685c5ed8bce9e186fa7e1d3db734f292c4d7aac8db7` |
| 내장 `codeHash`               | `fb419ff7fa6fcd34800bb2f2642f918e0c22d05563fd20ae95adbf11f5898d37` |
| `exposureModel`               | `acquisition-cost-calendar-time-v1`                                |
| `publication`                 | `all-two-symbol-snapshots-all-24-rows-no-ranking`                  |

protocol·collection-summary·experiment-verification의 내장 hash는 해당 `hash` 필드를 제외한 내용을, experiment-summary의 hash는 `studies` 배열을 키 정렬·공백 없는 UTF-8 JSON으로 직렬화해 SHA-256을 대조했고 모두 일치했다. 파일 바이트 SHA-256은 전체 원문에 대한 별도 값이다. `codeHash`는 protocol과 최종 검증 기록에 같은 값으로 연결돼 있다. 이러한 자기 일관성 검증을 원천 진위·수익성·실행 승인으로 해석하지 않는다.

`codePaths`에는 broker의 `dist/toss/index.js`, `dto.js`, `transport.js`, database의 `dist/lease.js`, worker의 `dist/historical-collect.js`, `historical-export.js`, `strategy-benchmark-study.js`, `strategy-research-snapshot.js`, trading의 `dist/backtest/engine.js`, `capital-exposure.js`, `pnpm-lock.yaml`이 기록돼 있다. 최종 실험 검증 기록은 같은 codeHash를 보존한다. 실행 코드 pin은 연구 입력·결과의 연결 근거이며 외부 공증이 아니다.

자료원·공식 문서 확인 시점은 [2026-11-09 Toss 공식 조사](TOSS_RESEARCH_API_2026_11_09.md)를 재사용한다. 해당 기록에 REST `1.2.28`의 11월6일 보관본 대비 동일성, 원문 URL·hash·접근 한계와 KO/JPM 발행사 1차 자료가 있다. 2026-11-09는 이 조사·연구 계획의 기록일이며, 공급자의 별도 정책 시행일이나 과거 연도 시세의 정확성을 입증하는 날짜가 아니다. 공식 자료에 없는 시행일을 추정하지 않는다.

## 대상: 두 종목 × 세 독립 연도

protocol의 `selectionReason`은 기존 AAPL/MSFT 부분 연도 입력에서 음료·금융서비스 기업과 세 개의 독립된 전체 달력 연도로 범위를 넓힌다는 취지다. 종목명은 엔지니어링 연구 대상이며 투자 추천이 아니다. 발행사 identification은 [공식 조사](TOSS_RESEARCH_API_2026_11_09.md)의 The Coca-Cola Company(NYSE: KO, 음료)와 JPMorgan Chase & Co.(NYSE: JPM, 금융서비스)를 따른다. 업종 라벨은 사업 설명의 요약이며 과거 GICS 분류 검증이나 업종 전체 대표성의 증거가 아니다.

| 연도 | 미국 현지 날짜 범위, 양끝 포함 | 달력 일수 | 독립 요청 ID          |
| ---- | ------------------------------ | --------- | --------------------- |
| 2023 | 2023-01-01 ~ 2023-12-31        | 365       | `ko-2023`, `jpm-2023` |
| 2024 | 2024-01-01 ~ 2024-12-31        | 366       | `ko-2024`, `jpm-2024` |
| 2025 | 2025-01-01 ~ 2025-12-31        | 365       | `ko-2025`, `jpm-2025` |

6개 요청은 모두 `market=US`, `interval=1d`, `source=toss`, `adjusted=false`, `role=research`다. 각 요청은 [기존 과거 입력 정책](HISTORICAL_DATASETS.md)의 최대 366일 이내다. 연도별 데이터셋·자금·초기 보유·warmup을 독립적으로 다루고 이전 연도 지표·수량·현금을 이월하지 않는다. 기간별 수익률·손익을 합산하거나 연결된 포트폴리오 성과로 표시하지 않는다.

## 고정 전략·대조군·비용

protocol은 아래 세 후보 각각에 기본·스트레스 execution을 기록한다. 모두 version `1.0.0`이다. 상세 신호 의미는 [전략 계열 연구](STRATEGY_FAMILY_STUDY.md), 대조군과 노출 산술은 [대조군·자본 노출 연구](STRATEGY_BENCHMARK_RESEARCH.md)의 기존 정의를 따른다.

| 후보          | protocol 전략 ID       | 고정 파라미터                          | 후보 ID                                            |
| ------------- | ---------------------- | -------------------------------------- | -------------------------------------------------- |
| 이동평균 교차 | `moving-average-cross` | `fastPeriod=5`, `slowPeriod=20`        | `ma-5-20-base`, `ma-5-20-stress`                   |
| 채널 돌파     | `channel-breakout`     | `entryPeriod=20`, `exitPeriod=10`      | `breakout-20-10-base`, `breakout-20-10-stress`     |
| 평균회귀      | `mean-reversion`       | `period=20`, `entryDeviationBps="200"` | `reversion-20-200-base`, `reversion-20-200-stress` |

단순 보유 대조군은 protocol의 `benchmark.entryAfterClosedCandles=21`을 사용한다. 기존 helper의 `buy-and-hold@1.0.0` 정의에 따라 21번째 종료 봉에 한 번 신호를 내고 다음 적격 시가에서 매수한다. 세 전략의 최초 판단 가능 시점과 맞추는 조건이며 첫날 시가에 매수하는 전 기간 보유 수익률과 구분한다. 미체결을 뒤늦게 재진입으로 바꾸거나 마지막 날 강제 청산하지 않는다. 대조군은 dataset·고유 execution별로 구분하고 후보와 자금을 공유하지 않는다.

| execution 필드 | 기본         | 스트레스     |
| -------------- | ------------ | ------------ |
| `initialCash`  | `"1000"` USD | `"1000"` USD |
| `quantity`     | `"1"`주      | `"1"`주      |
| `priceTick`    | `"0.01"` USD | `"0.01"` USD |
| `buyFeeBps`    | `"10"`       | `"20"`       |
| `sellFeeBps`   | `"30"`       | `"60"`       |
| `sellTaxBps`   | `"0"`        | `"0"`        |
| `slippageBps`  | `"5"`        | `"10"`       |

비용 파라미터를 사전에 고정한 실험이다. bps 비율을 고정 달러 수수료로 해석하지 않는다. 현재 계좌의 실제 수수료·미국 법정 비용·과거 호가 규칙·배당·기업행위·최종 정산을 검증한 설정이 아니며 `costAssumptionsVerified=false`다. 1주 운용 결과를 USD 1000 전액 투자 성과로 해석하지 않는다.

protocol의 예상 수량은 `expectedStrategyRuns=36`, `expectedBenchmarkRuns=12`, `expectedTotalRuns=48`이다. 최종 검증 기록의 실제 수량도 전략 36·대조군 12·전체 48조건으로 일치하며 `repeated=true`다. 각 조건의 두 번 실행은 반복 재현 확인이고 독립 실험 표본을 늘린 것이 아니다. 결과를 보고 후보·연도·비용을 골라 제외하거나 순위를 부여하지 않는다.

## 실제 수집 상한과 보존 요구

아래 protocol 값은 수집을 완료할 때까지 보장된 자원이나 재실행 권한이 아니라 중단 경계다.

| 원본 필드             | 기록값                     | 의미                                               |
| --------------------- | -------------------------- | -------------------------------------------------- |
| `maxPages`            | `40`                       | 수집 페이지 상한; 초과를 부분 완료로 처리하지 않음 |
| `maximumCollectionMs` | `1500000`                  | 전체 수집 최대 25분                                |
| `maximumPerDatasetMs` | `300000`                   | 개별 데이터셋 단계간 취소 확인 기준 5분            |
| `mustFinishBefore`    | `2026-11-09T01:26:26.921Z` | 절대 기한: 2026-11-09 10:26:26.921 KST             |
| `automaticRetry`      | `false`                    | 실패·불확실성을 자동 재시도로 바꾸지 않음          |
| `dbMarketDataStored`  | `false`                    | 시세를 DB에 저장하지 않는 계획                     |
| `executionEnabled`    | `false`                    | 거래 실행 비활성                                   |

기존 transport의 MARKET_INFO 초기 제한은 3 TPS이며 응답의 제한·잔여·reset 및 Retry-After를 따른다. 이는 사용자 지정값이나 protocol의 별도 TPS 필드가 아니며 실제 처리량·완료 시간을 보장하지 않는다. 개별 5분 취소 신호는 collector의 단계 사이에서 확인하며 broker의 진행 중 요청 취소 신호에는 연결되지 않았다. 따라서 개별 데이터셋이 정확히 5분 안에 중단된다는 보장은 없다. 진행 중 요청에는 기존 요청별 transport timeout/취소 정책을 적용하고, 전체 broker 수명에는 25분 및 절대 기한 신호를 함께 적용한다. 이 한계는 이번 수집 성공으로 해소된 것이 아니다.

실제 수집은 기존 source 수집 경로·읽기 전용 adapter·token manager와 같은 client의 인증 잠금 DB를 재사용했다. 파일 수집을 무DB·무토큰 실행으로 오해하지 않는다. client lock 범위 안에서 순차 수집을 기다리고 broker 수명을 취소한 뒤 범위를 종료하는 구조이며, collection-summary는 `brokerLeaseScopeCompleted=true`를 기록한다.

기존 업무/Paper 자산·현금·보유분·원가·정지/소유권 보존을 위해 수집 전후 읽기 전용 capture를 비교했다. 이번 성공 경로의 `paperBeforeHash`와 `paperAfterHash`는 모두 `b33dd910edd5cc8ae84a56c05464e25f3d27321a2311457503740e8ce8204f2f`이며 `paperLedgersUnchanged=true`다. 이는 스크립트가 선택한 대상 계좌 capture에서 `asOf`를 제외한 상태의 일치 확인이며 전체 DB의 바이트 동일성이나 모든 계좌 감사가 아니다. 시세 DB 미저장 플래그만으로 자산 보존을 판정하지 않았다.

실패·취소 경로는 사후 capture를 실행하지 않으므로 그 경로의 자산 보존은 미검증이다. 이번 성공 경로의 전후 일치를 실패 경로 검증 완료로 확대하지 않는다. 과거 거부된 예약은 `rejectedReservationCount=1`로 남았고 `reservationExceptionCreated=false`다. 기존 거부 기록을 수정하거나 예약 예외·거래 권한을 만들지 않았다. 키·client 식별자·토큰·계좌·원본 계좌 응답은 공개 문서에 포함하지 않는다.

## 재사용과 웹 조회 경계

새 library·새 endpoint·새 수집 알고리즘을 도입하지 않았다. 기존 `data:backfill` source 수집 경로, `collectHistoricalDataset`·파일 export, `backtest:benchmark`·연구 snapshot helper와 strict schema/hash 검증을 재사용한다. 구체적인 기존 사용법은 [과거 입력](HISTORICAL_DATASETS.md)과 [오프라인 연구·snapshot 작성](STRATEGY_BENCHMARK_RESEARCH.md)을 따른다. 수집 이후 전략·대조군 계산은 동결 파일만 사용했으며 최종 기록은 `brokerUsedForExperiment=false`, `dbUsedForExperiment=false`다. 이 플래그는 실제 broker와 인증 잠금 DB를 사용한 수집 단계까지 무접근이었다는 뜻이 아니다.

웹 조회의 서버 고정 root `.local-data/strategy-research`, localhost·소유자 cookie·빈 query·strict DTO·schema/hash 경계를 유지한다. reader는 검증된 저장 snapshot만 읽으며 원본 데이터·DB·전략을 재평가하거나 파일을 만들지 않는다. 브라우저 입력으로 파일 경로나 실행 대상을 받지 않는다. UI는 금액·노출 값을 표시하며 재계산·실행·재개 권한을 추가하지 않는다. snapshot 검증·게시 기록은 아래와 같으며 reader의 기본 root·인증 경계를 변경하는 연구가 아니다. 이 기록만으로 브라우저 시각 검증이나 전체 CI 통과를 주장하지 않는다.

| 구분                        | 최종 기록                          | 의미                                                          |
| --------------------------- | ---------------------------------- | ------------------------------------------------------------- |
| 기존 legacy 백테스트 리포트 | 48개, `legacyReportsVerified=true` | 신규 48조건과 별개이며 전후 목록 비교·개별 검증으로 보존 확인 |
| 기존 연구 snapshot          | AAPL·MSFT 두 hash 보존             | `priorResearchPreserved`에 기존 두 hash 기록                  |
| 신규 연구 snapshot          | KO·JPM 각 24행                     | 세 연도·두 비용의 세 전략과 대조군 전체를 게시하며 순위 없음  |
| 연구 snapshot 전체          | 4개, `allSnapshotsVerified=true`   | 저장 파일 reader 검증 결과이며 UI 시각 검증과 구분            |

입력은 collection의 요청·ID를 고정 protocol과 직접 대조하고, 실행 결과의 전략·대조군 수를 실제 행에서 집계한 뒤 protocol의 36/12/48과 확인했다. 기존 연구 snapshot은 이전 hash 집합이 이후에도 모두 남아 있는지 검사했으며 legacy 리포트도 전후 목록 비교와 개별 검증을 거쳤다. 이 검증은 기존 artifact를 덮어써 재구성한 결과가 아니라 새 연구 산출물을 추가한 뒤의 보존 확인이다.

## 연구 의미와 남는 편향

protocol은 `sourceIsRetrospective=true`, `pointInTime=false`, `untouchedHoldout=false`, `independentHoldoutVerified=false`, `strategySelected=false`, `prospectivePlanChanged=false`를 기록한다. `unseenHistoricalOutputsBeforePlan=true`도 기록돼 있지만 이는 protocol의 선언이다. 이전 열람 이력을 독립 감사한 것은 아니며, 새 심볼의 결과를 고정 전 보지 않았다는 선언을 독립 holdout의 증거로 사용하지 않는다.

신규 종목·전체 연도를 추가해도 사후 수집과 현재 생존 종목 선택의 편향은 남는다. KO/JPM 두 기업만으로 업종 전체·독립 표본·분산 효과를 입증하지 못한다. 두 종목은 같은 미국 시장·거시 환경에 노출되며 상관관계와 실효 표본 독립성을 검증하지 않았다. 독립 자금·별도 연도라는 실험 구조를 통계적 독립성으로 확대하지 않는다.

`adjusted=false`도 과거 원 가격을 보장하지 않는다. 배당·분할 등 기업행위와 실제 현금흐름, 원천 거래소·정규장 OHLC/종합 거래량 차이, 비용·정산 가정이 남는다. 수집본 hash는 동일 입력 재현과 변경 탐지를 돕지만 당시 알려진 정보만 사용했다는 증거가 아니다. 0체결·미청산·미체결·자료 누락·차액 null을 성공이나 우위로 바꾸지 않는다.

취득원가·달력 시간 기반 노출은 시가 기준 위험 노출·위험 조정 성과·연율화 알파가 아니다. 기간별 결과를 합산하지 않고 동일 dataset·비용의 대응 대조군과만 비교한다. 독립 holdout 검증·후보 선정·Paper 등록·전략 승인·실거래 권한은 제공하지 않는다.

[기존 미래 구간 계획](STRATEGY_FAMILY_STUDY.md)의 대상 **AAPL/MSFT, 2026-11-09~2027-02-26**과 고정 후보·비용·구간 내 warmup은 변경하지 않는다. KO/JPM 과거 연구를 해당 계획의 대체·완료·재예약으로 취급하지 않는다. `prospectivePlanChanged=false`도 이 경계를 기록한다.

## 수집 결과와 입력 hash

수집은 2026-11-09 01:17:04.802 UTC / 10:17:04.802 KST에 완료됐다. 6개 모두 `complete=true`, `pointInTime=false`이며 각 dataset의 관측 수와 선택 일봉 수가 같고 총 1504봉이다. `complete`는 기존 캘린더·커버리지·종료 판정 정책을 충족했다는 뜻이며 공급자 원천의 정확성이나 point-in-time 검증은 아니다.

| 입력     | 선택 일봉 / 관측 수 | dataset contentHash                                                |
| -------- | ------------------- | ------------------------------------------------------------------ |
| ko-2023  | 250 / 250           | `eedf5e97f71e62b23f5f649fbb102cbc0400b78fd9d19ac5e3a65a050f3064ce` |
| ko-2024  | 252 / 252           | `8baf46048e671fb32dd06c22746c5d4e12db83d879e8b5a2360bc1e9d2d2f348` |
| ko-2025  | 250 / 250           | `4932c36a0c567256809d61f4ac1b967d7a1286dac5450677e4b9b680beb2db69` |
| jpm-2023 | 250 / 250           | `08bfbfc5735977d3d1619ef4581bdd2088adff46a42a90168da76570bd564603` |
| jpm-2024 | 252 / 252           | `4bb8bcdbf7902be2dd8101b3b95dbc8aec94ca243c6194a294334380ef030287` |
| jpm-2025 | 250 / 250           | `fe3e92e33e00097ce99cc9e7710fe1c8ccebb70d84dddda49e47b7292a37b38a` |

collection-summary의 API 호출 집계는 종목 6회·미국 캘린더 2192회·캔들 12회·초기 토큰 발급 1회다. 인증값이나 실제 응답 원문은 포함하지 않는다. 초기 발급 1회를 자연 만료 갱신 검증으로 해석하지 않는다. 수집은 시세 DB 저장·주문 실행 없이 종료했다.

## 실험 결과와 잔량·미체결

2026-11-09 01:17:47.637 UTC / 10:17:47.637 KST의 experiment-verification은 전략 36·대조군 12·전체 48조건, `repeated=true`를 기록한다. KO/JPM 모두 선택 봉 수는 연도순 250/252/250개이며 각 24행을 생성했다. 아래 셀은 기본 / 스트레스 비용의 **순손익 USD**다. 각 기간 자금은 독립이며 표의 손익을 합산하지 않는다. 종료 보유분의 미실현 평가 손익이 포함되고 마지막 날 강제 청산 수익이 아니다.

| 종목 | 연도 |  이동평균 5/20 |    돌파 20/10 | 평균회귀 20/200bps | 단순 보유 N=21 |
| ---- | ---- | -------------: | ------------: | -----------------: | -------------: |
| KO   | 2023 |   1.33 / -0.17 | -1.83 / -2.72 |      -3.92 / -5.11 |  -1.98 / -2.07 |
| KO   | 2024 |  -4.33 / -7.17 |   2.21 / 0.96 |      -3.66 / -4.59 |     2.6 / 2.51 |
| KO   | 2025 | -8.51 / -10.96 |    3.6 / 2.91 |         5.78 / 3.6 |     6.19 / 6.1 |
| JPM  | 2023 |   0.84 / -4.33 |  16.98 / 14.6 |       1.24 / -2.31 |  29.88 / 29.67 |
| JPM  | 2024 |   13.35 / 8.01 | -5.09 / -11.4 |      24.73 / 19.52 |   65.8 / 65.54 |
| JPM  | 2025 |   11.72 / 5.77 | 30.74 / 25.94 |        18.4 / 11.4 |  51.97 / 51.56 |

| 집계                           |     KO |    JPM |    전체 |
| ------------------------------ | -----: | -----: | ------: |
| 전략 / 대조군 조건 수          | 18 / 6 | 18 / 6 | 36 / 12 |
| 0체결 조건                     |      0 |      0 |       0 |
| 종료 수량 1주인 전략 조건      |      2 |      8 |      10 |
| 종료 수량 1주인 대조군 조건    |      6 |      6 |      12 |
| 말기 미체결이 남은 조건 / 건수 |  0 / 0 |  2 / 2 |   2 / 2 |

종료 잔량은 KO 2025 평균회귀와 JPM 2023·2025 이동평균/돌파의 기본·스트레스 조건에 각 1주다. 대조군 12조건 모두 종료 1주를 보유한다. 합계 22조건의 종료 잔량은 서로 독립된 실험의 상태이며 하나의 실제 계좌 보유량으로 합산하지 않는다. JPM 2024 이동평균은 기본·스트레스 각각 말기 미체결 1건이 남는다. 모든 조건의 warmup 판단은 20회다. 0체결이 없다는 사실은 실제 주문 체결·전략 우위·운용 준비 완료의 증거가 아니다.

전체 36개 전략 행은 대응 대조군과 `comparisonStatus=compared`이고 12개 대조군 행은 `benchmark`다. 이는 같은 입력·비용의 산술 비교 상태이며 통계적 초과수익 검증이 아니다. MDD·체결/왕복 수·비용·실현/미실현 손익·보유 시간·취득원가는 private summary의 전체 행과 공개 snapshot에 보존한다. 표에서 유리한 조건만 선정하거나 후보 순위를 부여하지 않았다.

## 결과 식별자와 검토 증거

private 증거 루트는 `.local-data/sector-research/bb321f63-db4a-4368-918a-e1fa18b852e0/`다. protocol, collection-request/summary, 개별 dataset/receipt, KO/JPM manifest/result/repeat/review/snapshot, experiment-summary/verification을 구분해 보관한다. 아래 manifest 값은 파일 전체 바이트 SHA-256이며 result/snapshot의 내장 hash와 구분한다.

| 종목 | manifest 파일 SHA-256                                              | resultHash                                                         | snapshotHash                                                       |
| ---- | ------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| KO   | `e27578b709b3b6276f28515f8c56c8f8a2e8402c0bbc60681f1fd79558006acb` | `42d07192aa6e65c1c437d1244a281e436178701823fd73a116c71adc05185a66` | `f4411c148975f8c07b8ca0c391600dbee85808eb442c199e00205954f1fd259a` |
| JPM  | `f7fe318e2795738707e97ce2f0432bf2669976b43e2e08d8cd4c543f1fa49f60` | `e89bddba99c11f5e526332373164a5e4abaddd1f86fbc295de334ddd12b3c8e6` | `0bc63892288c1468170b6712f5c0c8320ff871523f35d733bb393961af075e4a` |

| 증거 파일                    | 내장 hash                                                          |
| ---------------------------- | ------------------------------------------------------------------ |
| collection-summary.json      | `bda33914bf230a436534b495a0a8fc68266944f5c03f7cfda16fe47ecaf00b69` |
| experiment-summary.json      | `0fa91516628262889496d733c2081cbdaa5bea5804014f926349441b587ab30c` |
| experiment-verification.json | `0ac9b22b9031ff294213b5fad4f9291d879c76ab0826507ac1b522608c82eb7e` |

기존 AAPL snapshot `1017295a6c85b1c65ed1b316c615c7c56300e85dff59675e4bac8a007b7863bd`, MSFT snapshot `33658de1916e75a19a22030182a01f271a5ca020946ba7c172b8d4590200f45e`가 보존됐다. 원본·결과·공개 DTO의 hash 연결과 반복 일치는 재현성·보존 검토이며 실제 비용·시장 독립성·독립 holdout·전략 승인 검증으로 확대하지 않는다. CI·브라우저 확인은 위 실험 요약과 별도 검증 범위로 구분한다.

## CI와 브라우저 확인 범위

2026-11-09 새 일회용 localhost 전용 DB에서 로컬 verify:ci가 123파일·938개 테스트(55.80초), exit 0으로 통과했다. 포맷·린트·타입·전체 빌드와 개발/로컬 운영 두 Compose 설정 검사도 통과했다. 로컬 실행 결과를 원격 Actions 통과로 확대하지 않는다.

브라우저에서는 신규 JPM 리포트를 열고 2025년 필터에서 네 행이 표시되는 것을 확인했다. 비용 선택 항목 표시는 확인했으나, 선택 전 사용자 Chrome 전환과 조작이 충돌하여 스트레스 클릭 후 결과 변경은 확인하지 못했다. 따라서 비용 전환의 전체 브라우저 동작을 검증 완료로 표시하지 않는다.

데스크톱과 412px 모바일 화면에서는 기존 데이터 표시와 탭 토글을 확인했다. 다만 최종 nowrap 수정 이후 스크린샷은 확인하지 않았으므로 최종 레이아웃의 시각 검증은 미완료다. 이 확인 범위를 모든 신규 데이터·비용 조합이나 최종 화면 전체의 검증으로 확대하지 않는다.
