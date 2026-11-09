# 단순 보유 대조군·자본 노출·연구 화면

2026-11-06 기존 [전략 계열 비교](STRATEGY_FAMILY_STUDY.md)에 단순 보유 대조군과 취득원가/보유 시간 지표를 추가했다. 새 의존성 없이 기존 Strategy·백테스트 엔진·Decimal·strict 계약·안전 파일 helper를 재사용한다. 기존 36조건과 원본 입력/결과를 보존하며 Paper 전략·계좌·관측·실주문을 변경하지 않는다.

## 사전에 고정한 대조군

`buy-and-hold@1.0.0`은 `entryAfterClosedCandles`번째 종료 봉에서 한 번만 매수 신호를 내고 다음 적격 시가에 기존 execution.quantity만큼 매수한다. 보유 중에는 매도하지 않고 마지막 봉 종가의 평가 손익/수량을 그대로 남긴다. 해당 시점에 현금/데이터가 부족하거나 다음 시가가 없어도 뒤늦게 자동 재진입하지 않는다.

이번에는 N=21이다. 세 후보의 첫 판단 가능 시점(이동평균 slow+1, 돌파 entry+1, 평균회귀 period+1)과 N이 모두 같아야 manifest를 허용한다. 첫 기간 시가에 바로 사는 전 기간 단순 보유 대조군과 다르며 **같은 최초 진입 기회부터의 1주 보유 대조군**이다. 후보가 실제로 신호를 낸 시각에 맞춰 대조군 진입 시점을 사후 변경하지 않는다. warmup도 전체 평가 구간에 포함한다.

각 dataset·고유 execution 설정마다 대조군 한 개를 만든다. 초기 현금·수량·가격 단위·수수료·세금·슬리피지·선택 체결 규칙 전체가 같은 쌍만 연결한다. 비용이나 자금이 다르면 대조군을 따로 실행한다. 후보끼리 현금·보유분을 공유하지 않는다.

기존 AAPL/MSFT 3기간의 세 후보 × 두 비용인 36조건을 다시 실행하고 12개 대조군을 추가해 **48조건**을 각각 두 번 실행했다. 기존 36조건의 전체 result hash가 그대로다. 입력은 이미 열람한 사후 수집본이며 pointInTime=false다. 미래 확인 구간 계획과 기존 비용 가정을 변경하지 않았다.

고정 protocol hash는 `6c05ef9c8b9dfb0ad99295fcf1773c79c3ea2785169b1b5143b6821a26d3c50d`다. 결과 열람 전에 기존 manifest/hash·21봉 조건·지표 의미·모든 조건 게시를 private protocol에 고정했다. 실행 코드/lockfile hash도 계산 전에 별도로 기록했고 종료 시 같음을 확인했다.

## 자본 노출 지표

`calculateCapitalExposure`는 저장 보고서의 전체 체결과 평가 구간을 재구성하는 순수 함수다. 시장 데이터를 수집하거나 전략을 재평가하지 않는다. 현재 long-only 전량 체결 모델만 지원하고 부분 체결·공매도·피라미딩 자료는 거부한다. 실제 계좌의 자산 지표가 아니다.

| 지표                       | 정의                                                                     |
| -------------------------- | ------------------------------------------------------------------------ |
| 평가 구간                  | 최초 initial equity 시각 ~ 마지막 equity 시각                            |
| 보유 시간/비율             | 위 구간에서 실제 체결 후 양수 수량을 보유한 밀리초와 전체 구간 대비 비율 |
| 최대 투자 원가             | 구간 중 보유 포지션의 최대 취득 대금 + 매수 수수료                       |
| 평균 투자 원가             | 각 체결 사이 취득원가 × 경과 시간의 합 ÷ 전체 평가 시간                  |
| 최대 투자 원가 대비 순손익 | 전체 순손익 ÷ 최대 투자 원가 × 100                                       |
| 매수/매도 대금 합계        | 각 방향의 체결 대금 합계. 수수료를 포함한 투자 원가와 구분               |

시간은 **야간·주말·휴장을 포함한 달력 시간**이다. 거래 세션 내 노출 시간으로 표시하지 않는다. 평균 원가는 그 사이 시가로 재평가하지 않고 취득원가를 유지한 시간 가중값이다. 시가 평가 기준 평균 익스포저·일별 수익률·위험 조정 알파·Sharpe·연율화 수익률을 계산한 것이 아니다. 보유 비율로 수익률을 나누거나 투자하지 않은 현금의 기회비용을 추정하지 않는다.

평가 시간이 0이면 보유 비율은 0, 평균 원가는 0, 원가 대비 비율은 null이다. 투자 원가가 0이어도 비율은 null이다. 화면에서 각각 측정 구간 없음/투자 없음으로 구분한다. 체결이 없는 전략과 대조군은 순손익 차이를 null로 남기고 미검증으로 표시한다. 둘 다 체결이 있으면 후보 순손익 − 대조군 순손익을 표시하지만 우위·초과수익의 통계 검증이나 전략 선정이 아니다.

보고서 schema/model·시각 순서·체결 구간·초기 보유 0·가격×수량=대금·현금·수수료/세금·원가·실현/미실현·종료 수량/자산을 함께 검사한다. 저장 지표와 재계산 값이 다르면 결과 검토를 거부한다. Decimal precision=1000으로 보고서의 최대 십진 길이와 시간 가중 계산을 처리하고 출력 비율/평균은 소수 10자리로 기록한다. 기존 엔진의 산술과 hash는 변경하지 않는다.

## 실행과 보관

```bash
# 오프라인 실행. broker/키/DB/.env 없이 동결 파일만 읽는다.
corepack pnpm backtest:benchmark \
  --manifest="$PWD/.local-data/strategy-benchmark-studies/<UUID>/aapl-manifest.json" \
  --output="$PWD/.local-data/strategy-benchmark-studies/<UUID>/aapl-result.json"

# 원본 동결 파일을 다시 읽거나 전략을 실행하지 않는 저장 결과 검토
corepack pnpm backtest:benchmark \
  --manifest="$PWD/.local-data/strategy-benchmark-studies/<UUID>/aapl-manifest.json" \
  --input="$PWD/.local-data/strategy-benchmark-studies/<UUID>/aapl-result.json" \
  --output="$PWD/.local-data/strategy-benchmark-studies/<UUID>/aapl-review.json"

# 동일 검토 후 공개용 최소 DTO를 별도 파일로 작성. 기존 파일은 덮어쓰지 않는다.
corepack pnpm backtest:benchmark \
  --manifest="$PWD/.local-data/strategy-benchmark-studies/<UUID>/aapl-manifest.json" \
  --input="$PWD/.local-data/strategy-benchmark-studies/<UUID>/aapl-result.json" \
  --snapshot --output="$PWD/.local-data/strategy-benchmark-studies/<UUID>/aapl-snapshot.json"
```

manifest는 `strategy-benchmark-study-v1`, `study`(기존 strategy-study-v1 객체), `benchmark`(entryAfterClosedCandles), `exposureModel=acquisition-cost-calendar-time-v1`을 요구한다. 기존 manifest/결과 형식을 확장하거나 느슨하게 바꾸지 않는 별도 wrapper다. 결과는 기존 전체 연구 결과와 대조군 전체 보고서·노출 지표·중첩 hash를 보존한다.

dataset 최대 8·후보 최대 8, 대조군을 포함한 전체 실행 최대 32·전체 처리 100000봉·manifest 1MiB·입력 합계 64MiB·누적 전체 보고서 32MiB·출력 64MiB를 유지한다. safe helper로 새 디렉터리 0700/파일 0600, 기록·sync 후 원자적으로 게시하며 덮어쓰기나 자동 재시도를 하지 않는다.

공개용 snapshot은 verified review에서만 생성한다. dataset의 로컬 UUID·원본 OHLCV·신호/체결 배열·파일 경로·키/계좌 정보를 제거하고 요청 범위·전략/비용·성과·노출·비교 상태·근거 hash만 담는다. SHA는 자기 일관성/변경 탐지이며 진위 서명이나 가격/비용/전략 수익성의 인증이 아니다. sourceResultHash와 manifestHash는 생성 당시 연결 근거이며 HTTP에서 원본 연구·동결 파일까지 다시 검증하지 않는다.

## 웹/API 경계

소유자 로그인 후 [전략 연구](http://localhost:5173/research)를 연다. 기본은 첫 dataset·첫 비용의 네 후보(세 전략+대조군)이며 전체 기간/비용도 선택할 수 있다. 순위 정렬이나 운용/실행 버튼은 없다. query key와 snapshot hash를 함께 검사해 이전 응답/오류가 다른 선택의 결과로 표시되지 않게 한다. 모든 금액·지표는 서버 결과를 표시하며 브라우저에서 계산하지 않는다.

API는 `GET /v1/strategy-research`와 `GET /v1/strategy-research/:hash`만 제공한다. main의 loopback/localAccess에서 서버 고정 `.local-data/strategy-research` reader만 연결한다. 목록/상세 모두 소유자 cookie·localhost/Host/Origin·빈 query·strict 응답·no-store 경계를 유지한다. URL로 파일 경로나 실행 옵션을 받지 않는다. forwarded IP로 외부 접속을 허용하지 않는다. 기존 일반 경로·OwnerAccess와 SPA fallback을 유지한다.

고정 루트에 `<snapshotHash>.json`으로 게시한 파일만 읽는다. 루트/파일 symlink·교체·파일 증가를 검사하고 이름·schema·전체 payload hash를 재검증한다. 목록은 100 entry·전체 16MiB, 개별 파일 1MiB 상한을 유지하고 제외 수/상한 도달을 표시한다. 상세는 캐시 없이 재검증한다. 조회는 파일 생성·DB·worker·전략/대조군 재실행·시세 수집·Paper 재개를 하지 않는다. 오류에 경로/PID/원본 예외를 넣지 않는다.

## 이번 결과와 보존 확인

단순 보유 대조군 순손익 USD다. 셀은 기본 / 스트레스 비용이며 후보별 상세 차이·보유 시간·원가는 웹의 같은 기간·비용 행에서 확인한다. 마지막 시가에 팔았다는 가정 없이 미실현 평가 손익과 매수 비용이 포함된다.

| 종목 | 기간             | 21봉 이후 단순 보유 순손익 |
| ---- | ---------------- | -------------------------: |
| AAPL | 2026-01-02~04-30 |                1.74 / 1.34 |
| AAPL | 2026-05-01~08-31 |                8.92 / 8.46 |
| AAPL | 2026-09-01~10-30 |              14.12 / 13.63 |
| MSFT | 2026-01-02~04-30 |            -14.88 / -15.51 |
| MSFT | 2026-05-01~08-31 |              59.73 / 59.06 |
| MSFT | 2026-09-01~10-30 |                1.24 / 0.46 |

이번 입력은 모두 기존 열람 자료이며 독립 수익성 검증이 아니다.

private 루트는 `.local-data/strategy-benchmark-studies/5ab306b4-53c7-4664-b367-d34f8335a05e/`다. protocol·execution-pin·두 manifest/result/repeat/review/snapshot·summary·verification을 보관했다. AAPL 전체 result hash는 `a619573bb70e05f710dea8d0d397dc174a8db97a10a323fefe57d5253a7eac15`, MSFT는 `d647f82440813abc249d86e8425910b0c50d7644b451aaa944f536e42d03cff2`로 반복 일치했다.

연구 snapshot은 AAPL `1017295a6c85b1c65ed1b316c615c7c56300e85dff59675e4bac8a007b7863bd`, MSFT `33658de1916e75a19a22030182a01f271a5ca020946ba7c172b8d4590200f45e`다. 모두 전체 24행을 게시해 제외 0·상한 미도달을 확인했다. 이전 연구/데이터/기존 공개 백테스트 48개는 보존했다. 실제 계좌·Paper·관측 예약·키/토큰은 사용하거나 변경하지 않았다.

## 최종 정합성 보강과 확인 경계

이름만 다르고 전략/파라미터/비용이 같은 후보 조건은 실행 전에 거부한다. 0체결에서 양수 투자 원가·보유 시간·비용·손익이 나타나거나 잔량/초기 현금 관계가 맞지 않는 snapshot도 거부한다. 대조군 차액은 worker의 Decimal 검증 helper가 두 순손익의 차이와 일치하는지 확인하며 API reader와 snapshot 작성에 공통 적용한다. 브라우저에서 차액을 계산하지 않는다.

보강된 최종 코드로 48조건을 다시 두 번 실행해 이전 result/snapshot hash가 모두 같고 원본이 보존됨을 확인했다. 최초 pin/결과를 수정하지 않고 final-execution-pin·final-verification을 추가했다. 이미 게시한 두 snapshot의 바이트/식별자를 바꾸지 않았다.

실제 저장 snapshot 2개/각 24행을 격리된 Fastify inject 인스턴스와 합성 테스트 소유자로 조회했다. 운영 로그인 설정/세션을 변경하지 않고 미인증·외부 접속·임의 query 차단도 확인했다. 로컬 Vite의 `/research`는 HTTP 200, 미로그인 실제 연구 API는 401이었다. 브라우저 직접 확인은 사용자 브라우저 조작과 충돌해 완료하지 못했다. 화면 구조·초기 필터·지연 응답·인증 경계는 React 렌더/Query/라우팅 테스트로 확인하며 이를 시각 검증 완료로 표시하지 않는다.

## 최종 전체 검증

새 전용 localhost 테스트 DB에서 최종 `verify:ci`가 123파일·933개 테스트(51.52초)와 포맷·린트·타입·전체 빌드를 통과했다. 개발/로컬 운영 Compose 설정 검사도 통과했다. 관련 API/연구/화면의 보강 회귀 검사 26개와 도메인 계산 11개, 로그인/라우팅·나머지 회귀를 전체 검사에 포함했다. 정적 독립 검토에서 찾은 중복 조건·저장 요약 산술 두 건을 수정한 뒤 다시 전체 검사했다. 원격 Actions 결과와 구분한다. 테스트용 임시 DB 컨테이너는 종료하며 업무/Paper DB는 변경하지 않는다.

## 후속 입력 확대

[2026-11-09 KO·JPM 연구](SECTOR_RESEARCH_EXPANSION.md)는 같은 후보·비용·대조군으로 2023~2025 전체 연도를 별도로 검토한다. 기존 AAPL/MSFT 결과와 미래 확인 계획을 보존하며, 종목/연도 간 수익률을 합산하거나 전략을 자동 선정하지 않는다.
