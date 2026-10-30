# HTH Stock Trading

개인용 국내·미국주식 자동매매 시스템입니다. **읽기 전용 토스 연동·캔들 저장·로컬 대시보드와 이동평균 교차 백테스트를 제공합니다. Paper 주문 원장·원자적 예약·내부 모의 체결도 구현했습니다. 합성 데이터의 상시 Paper 실행·복구 루프도 제공합니다. 로컬 합성 Paper 조회·긴급 정지 화면도 제공합니다. 단일 소유자 로그인과 전략 설정·활성 관리도 제공합니다. 실제 시세용 Paper CLI도 추가했으며 실데이터 운용 검증·외부 배포·실제 주문은 후속입니다.** 기본 dev는 키 없이 실행할 수 있으며, `DASHBOARD_ENABLED=true`일 때만 대시보드가 worker를 통해 실제 데이터를 조회합니다. `TRADING_MODE=live`는 거부합니다.

## 구성

- `apps/web`: React + Vite + Tailwind CSS, TanStack Query v5와 Lightweight Charts 대시보드
- `apps/api`: Fastify, 생존 확인 및 localhost 전용 대시보드 API
- `apps/worker`: 읽기 전용 확인·수집 명령과 대시보드 조회용 자식 프로세스
- `packages/contracts`, `broker`, `trading`, `database`: 공통 계약, 토스 adapter, 전략 계약, Drizzle 저장소

설계: [PRD](PRD.md), [아키텍처](ARCHITECTURE.md), [상세 설계](DESIGN.md), [토스 공식 API 조사](docs/TOSS_API.md), [개발 지침](AGENTS.md).

## 로컬 실행

Node.js 24와 Corepack이 필요합니다. pnpm은 packageManager에 고정합니다. 전역 pnpm이 없다면 모든 명령을 `corepack pnpm`으로 실행할 수 있습니다.

```bash
corepack pnpm install --frozen-lockfile
cp .env.example .env
corepack pnpm dev
```

web: http://localhost:5173, API 생존 확인: http://localhost:4000/health/live. 앱은 현재 PostgreSQL 없이 실행됩니다. API의 health는 거래 준비 상태나 DB 연결을 보장하지 않습니다.

백테스트는 http://localhost:5173/#backtests 에서 `.local-data`에 저장한 리포트의 지표·곡선·거래 내역과 두 실험 조건을 비교합니다. 키·DB 없이 합성 데모를 만드는 방법은 [백테스트 문서](docs/BACKTESTING.md)에 있습니다.

개별 실행은 `corepack pnpm dev:web`, `dev:api`, `dev:worker`입니다. dev는 web/API를 실행하며 API 실행 전에 공통 패키지와 worker를 빌드합니다. 기본 worker 상시 프로세스는 아직 대기용이므로 별도 실행하지 않아도 됩니다. 패키지나 worker 소스를 변경하면 다시 빌드하고 API를 재시작하세요. 서버 설정은 루트 `.env`, 공개 웹 설정은 `apps/web/.env.local`에 둡니다. `VITE_API_URL`은 `/api`로 설정하며 Vite가 localhost API에 프록시합니다.

## 실제 데이터 대시보드

키·DB·허용 IP 설정이 완료됐다면 루트 `.env`에 `DASHBOARD_ENABLED=true`를 설정하고 다음을 실행합니다. `false`가 기본값이며 해당 설정은 거래 권한이 아닙니다.

```bash
corepack pnpm infra:up
corepack pnpm dev
```

http://localhost:5173 에서 KRW/USD 주식 평가액·평가 손익·매수 가능 금액·보유 종목·관심 종목·캔들 차트·시장 세션을 확인합니다. 관심 종목 선택과 전체/국내/미국 보유분 필터를 지원합니다. 평가액은 현금 제외 주식 가치이며 손익은 수수료·세금 미반영입니다. 모든 기존 보유분은 조회만 하며 자동매매 소유권을 부여하지 않습니다.

API 시작 시 한 번 조회하고 새로고침 버튼으로 재조회합니다. 브라우저의 3초 polling은 API의 메모리 캐시만 읽으며 토스를 반복 호출하지 않습니다. 재조회는 단일 작업·최소 30초 간격·전체 120초 제한입니다. 실패하면 마지막 성공 결과와 오류 표시를 유지하며 3분 경과 시 오래된 데이터로 표시합니다. 데이터는 서버·브라우저 메모리에만 있고 계좌번호·토큰·client secret은 공개 모델에 포함하지 않습니다. 서버 응답은 `no-store, private`이며 로그에 잔고와 원문 응답을 남기지 않습니다.

현재 대시보드는 **같은 컴퓨터의 개발 환경 전용**입니다. API는 대시보드 활성 상태에서 loopback bind만 허용하고 production 시작을 거부합니다. 요청의 원격 IP·Host·Origin·Sec-Fetch-Site 및 새로고침 전용 헤더를 검사합니다. 이는 로컬 OS 사용자 신뢰 경계이며 사용자 로그인·OIDC 인증을 구현한 것은 아닙니다. LAN 공개, 포트포워딩, 터널 또는 실제 자산 정보의 Vercel 공개 배포는 지원하지 않습니다. 외부 배포 전에 소유자 인증과 TLS 배포 경계를 구현해야 합니다.

API가 직접 증권사에 접속하지 않고 공개 worker entrypoint를 fork하여 Node IPC로 검증된 모델을 받습니다. worker는 기존 DB advisory lock을 사용합니다. 조회마다 worker와 메모리 토큰이 종료되며, 같은 client의 동시 CLI 조회는 잠금으로 제한합니다. 대시보드는 마이그레이션이나 시세 DB 저장을 수행하지 않습니다.

`packages/contracts` (`@hth/contracts`)는 앱 간 공유하는 Zod 계약·시장/통화 타입이며 앱 내부 `src/shared`와 구분합니다. 새 의존성은 서버 상태용 TanStack Query v5, 캔들 표시용 Lightweight Charts, 정확한 자산 계산용 `decimal.js`입니다. 차트 렌더링에서만 가격을 number로 변환하며 원장·자산 계산은 십진 문자열과 80자리 정밀 계산을 사용합니다. Lightweight Charts의 TradingView attribution을 화면에 표시합니다.

## 검증

```bash
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm format:check
```

테스트는 안전 모드, API, 토스 DTO·인증·호출 제한·재시도·타임아웃·시장 날짜·캔들 정규화·잠금을 확인합니다. 실제 증권사 요청은 하지 않습니다. 일반 테스트는 DB 없이 실행하며 PostgreSQL 통합 테스트 1개는 건너뜁니다. CI는 전용 PostgreSQL에서 통합 테스트도 실행합니다. 로컬 통합 테스트를 활성화하려면 localhost의 전용 DB에 `TEST_DATABASE_URL=postgresql://hth_test:local_test_only@localhost:5432/hth_readonly_test`를 지정합니다. 이 테스트는 지정한 전용 DB에 마이그레이션을 적용하고 시세 테이블을 초기화합니다. 개발/운영 DB URL을 사용하지 마세요.

초기 검증에서 lint·typecheck·테스트 4개·build·포맷·Compose 문법·마이그레이션 SQL 생성을 확인했습니다. API와 웹 프로덕션 미리보기의 HTTP 200, worker의 Paper 대기와 정상 종료도 확인했습니다. API/worker 운영 산출물은 `live` 설정 시 시작을 거부합니다. Docker 이미지 빌드는 현재 환경에서 npm 인증서 체인 오류(`UNABLE_TO_GET_ISSUER_CERT_LOCALLY`)로 완료하지 못했습니다. TLS 검증을 비활성화하지 않았으며, 올바른 CA 신뢰 설정을 갖춘 환경에서 재검증해야 합니다. 사용자 DB에 대한 마이그레이션 적용과 Vercel 배포는 수행하지 않았습니다.

읽기 전용 연동 추가 후에는 일반 테스트 34개와 별도 임시 PostgreSQL 통합 테스트 1개를 통과했습니다. 임시 DB에서 upsert·rollback·lease를 검증했으며 사용자 개발 DB나 토스 실계좌에 연결하지 않았습니다.

## 토스 읽기 전용 확인과 수집

WTS Open API에서 발급한 키를 루트 `.env`의 `TOSS_CLIENT_ID`, `TOSS_CLIENT_SECRET`에 설정하고 실행 환경의 출구 IP를 허용 목록에 등록합니다. 키는 채팅·브라우저·Git에 넣지 않습니다. 공개 설정인 `READONLY_SYMBOLS`는 `KR:005930,US:AAPL` 형식이며 최대 20종목, `CANDLE_INTERVAL`은 `1m`/`1d`, `CANDLE_MAX_PAGES`는 종목당 1–5페이지입니다. 현재는 수정주가 미적용(`adjusted=false`)으로 수집합니다.

```bash
corepack pnpm infra:up
corepack pnpm broker:check
```

`broker:check`는 계좌·보유분·KRW/USD 매수가능금액, 종목·현재가·캔들·시장 일정·환율을 한 번 조회합니다. 로그에는 키·계좌 참조·보유 금액 대신 개수와 실행 비활성 상태만 출력합니다. DB는 토큰 중복 발급 방지 advisory lock에 사용하며 조회 데이터를 저장하지 않습니다. 키가 없거나 DB 잠금을 얻지 못하면 인증 요청 전에 실패합니다.

캔들까지 저장하려면 생성된 마이그레이션을 검토·적용한 다음 실행합니다.

```bash
corepack pnpm db:migrate
corepack pnpm broker:sync
```

`broker:sync`는 전체 조회가 성공한 뒤 종목·캔들·가격 revision을 하나의 트랜잭션으로 저장합니다. 저장 실패는 전체 rollback합니다. 마이그레이션 `0001`이 필요합니다. 계좌 잔고·키·환율·현재가는 아직 저장하지 않습니다. 날짜 범위를 지정한 과거 수집과 재현 가능한 동결 입력은 별도의 `data:backfill`·`data:export` 명령을 사용합니다. 기본 백필은 저장 없는 dry run입니다. [명령·제약·데이터셋 정책](docs/HISTORICAL_DATASETS.md)

토큰은 worker 명령 내부에서 공유하며 동일 client ID의 다른 프로세스는 같은 PostgreSQL DB를 사용해야 합니다. 별도 DB나 외부 스크립트의 발급까지 막지는 못합니다. 단발성 명령을 종료하면 토큰은 메모리에서 사라지고 다음 실행에 새로 발급합니다. 웹/API는 여전히 토스에 직접 연결하지 않으며 기본 worker에 주기 수집을 자동 활성화하지 않습니다.

broker 원본 봉은 `isClosed=false`이며 worker가 시장 세션·60초 대기·종료 후 재수집을 확인해 종료 플래그를 설정합니다. 시세·계좌·캘린더·환율·캔들 신선도 검증도 수행합니다. 대시보드의 **전략 입력 데이터 검증**에서 종료/대기/제외 봉과 차단 사유를 확인할 수 있습니다. 통과 보고서도 `validUntil` 이후 만료됩니다. 원천 데이터의 영구 불변·전략 실행·주문 승인을 보장하지 않습니다. [상세 정책](docs/MARKET_DATA_POLICY.md)

## 로컬 PostgreSQL과 Docker

```bash
corepack pnpm infra:up
corepack pnpm db:generate
corepack pnpm db:migrate
corepack pnpm infra:down
```

초기 마이그레이션 SQL은 `packages/database/migrations`에 포함되어 있습니다. 스키마를 바꿀 때 `db:generate`로 추가 생성하고 SQL을 검토한 뒤 명시적으로 적용합니다. 현재 스키마는 시세·revision·동결 데이터셋과 Paper 의도·예약·체결·전략별 원가 원장을 포함합니다. Compose 비밀번호는 localhost 개발 전용이며 운영에 재사용하지 마세요. DB volume은 `infra:down`으로 삭제하지 않습니다.

```bash
docker compose -f infra/docker-compose.yml --profile apps up --build
```

API와 대기 worker를 컨테이너로 확인하는 개발용 구성입니다. 상시 운영에는 고정 출구 IP, TLS, 인증, 비밀 관리, 관측·백업 구성을 추가해야 합니다. runtime image 최적화와 운영 배포는 Phase 5 작업입니다.

## Vercel

공개 SPA 빌드의 Root Directory는 `apps/web`, Framework는 Vite입니다. `vercel.json`에 빌드·출력 경로와 SPA rewrite가 있습니다. 현재 `/api` 프록시는 로컬 Vite 개발·미리보기 서버에만 있으며 Vercel에서 실제 계좌를 조회할 수 있도록 연결하지 않습니다. 외부 배포는 소유자 인증과 안전한 프록시 구성을 구현한 후 진행합니다. 토스 키·토큰·계좌 정보는 Vercel 프론트 환경변수에 등록하지 않습니다. 실제 배포는 수행하지 않았습니다.

## 소유자 인증

비공개 화면과 API는 로그인이 필요합니다. 먼저 `corepack pnpm owner:hash`로 서버 전용 `.env.owner`를 생성하고 API를 재시작합니다. 원문 비밀번호는 저장하거나 출력하지 않습니다. 인증 미설정 상태에서는 데이터 접근을 차단합니다. [등록·세션 정책](docs/OWNER_AUTH.md)

Paper의 **설정 · 활성 관리**에서 이동평균 조건·수량을 저장할 수 있습니다. 저장 시 실행이 정지되고 재개는 별도 절차입니다. DB revision과 변경 이력을 보존합니다. [전략 설정 정책](docs/STRATEGY_SETTINGS.md)

등록 전략의 **변경 이력**에서 과거 설정과 현재 설정의 차이를 확인할 수 있습니다. 조회 전용이며 복원·재개를 수행하지 않습니다. [조회·비교 정책](docs/STRATEGY_HISTORY.md)

Paper **자산 추이**는 앞으로 관측·체결·대사한 평가값부터 저장합니다. 원화·달러별 최초 기록 대비 변동률이며 수동 보유분도 포함합니다. 과거 이력이 없으면 빈 상태입니다. [평가 기록과 해석](docs/PAPER_EQUITY.md)

Paper **전략 신호·주문 차단 진단**에서 worker가 저장한 HOLD·봉 부족·기존 보유·중복 신호·리스크 거부 등을 확인합니다. 현재 정지 상태와 과거 판정을 구분하며 조회로 평가/거래를 시작하지 않습니다. [진단 기록과 한계](docs/PAPER_DIAGNOSTICS.md)

## 다음 작업

Paper 리스크 검증 기반도 구현했습니다. `corepack pnpm risk:demo`는 키·DB 없이 합성 12개 시나리오를 실행합니다. 투자 한도·비용·예약·수동 보유 보호·정지 후 무효화를 확인할 수 있으며 실제 주문이나 DB 예약은 수행하지 않습니다. [범위와 다음 원장 작업](docs/PAPER_RISK.md)

1. 외부 배포용 소유자 인증·세션·TLS 및 프록시 경계를 구현합니다. 로컬 읽기 전용 대시보드는 구현했습니다.
2. 날짜별 캘린더·백필·revision·동결 데이터셋을 구현했습니다. 생성한 마이그레이션을 검토한 뒤 사용자 DB 적용과 데이터셋 저장을 진행합니다.
3. 백테스트 엔진·CLI·로컬 결과 조회와 비교 화면까지 구현했습니다. [백테스트 실행과 모델 가정](docs/BACKTESTING.md)을 확인하고 실제 동결 입력과 여러 기간으로 검증합니다.
4. [Paper 주문 원장·원자적 예약](docs/PAPER_LEDGER.md)을 구현하고 임시 DB에서 검증했습니다. [모의 체결·부분 체결·잔고/소유권·원가 반영](docs/PAPER_FILLS.md)도 구현했습니다. [상시 worker의 복구·관측 갱신·실행 루프](docs/PAPER_WORKER.md)와 테스트 DB 전용 `corepack pnpm paper:demo`도 추가했습니다. 기본 정지이며 `--resume`으로만 모의 거래를 시작합니다. [Paper 조회·긴급 정지 화면](docs/PAPER_DASHBOARD.md)도 추가했습니다. 기본 비활성이며 별도 모의 계좌를 연결한 후 `http://127.0.0.1:5173/#paper`에서 확인합니다. 소유자 인증과 전략 설정·활성 관리도 구현했습니다. DB 출처 영속화와 합성/실제 시세/미확인 표시를 지원합니다. [실제 시세 Paper CLI](docs/PAPER_MARKET_SOURCE.md)도 기본 정지·전용 모의 DB·토큰 잠금 공유 방식으로 추가했습니다. [휴장 대기·일일 기준 검토 CLI](docs/PAPER_SESSIONS_REVIEW.md)를 추가했습니다. [읽기 전용 시세 관측/리포트 CLI](docs/MARKET_OBSERVATION.md)를 추가했습니다. 다음은 여러 시장 세션의 실데이터 관측 결과 축적과 검토입니다. 사용자 DB에는 새 마이그레이션을 적용하지 않았습니다.
5. 전략 설정 이력 조회·비교 UI는 구현했습니다. [실제 시세 운영 검증 목록](docs/OPERATIONAL_VALIDATION.md)에 따라 반복 관측·시장별 정규장·경계·프로세스 수명을 확인합니다. 외부 배포용 HTTPS/프록시/세션 운영 경계와 실거래는 후속 범위입니다.

휴장 대기와 장시간 중단 후 손실 기준 검토는 [Paper 세션·검토 절차](docs/PAPER_SESSIONS_REVIEW.md)를 따릅니다. 개장이나 검토 승인으로 자동 재개하지 않습니다.

시세 수집 상태만 점검하려면 `corepack pnpm market:observe --demo` 또는 실제 설정 후 `corepack pnpm market:observe`를 사용합니다. 주문·Paper 재개 없이 journal과 운영 리포트를 저장합니다. [실행/파일/범위](docs/MARKET_OBSERVATION.md)

관측 중 웹 계좌 현황도 새로고침하려면 새 관측 실행에 `--share-dashboard`를 지정합니다. 관측 worker의 인증·호출 제한을 재사용하며 토큰을 브라우저나 파일로 전달하지 않습니다. [공유 방식과 적용 범위](docs/SHARED_DASHBOARD.md)

저장된 운영 리포트는 로그인 후 `http://127.0.0.1:5173/#observations`의 **시세 관측** 메뉴에서 확인합니다. 파일 형식·해시·집계를 검증하며 조회로 관측이나 매매를 시작하지 않습니다. [조회 범위와 제한](docs/MARKET_OBSERVATION.md)

같은 화면 위쪽의 **정규장 관측 예약 기록**에서 시작 누락 실패와 결과 미확인을 구분합니다. 완료 로그의 데이터 품질은 리포트에서 별도로 확인합니다. [예약 상태의 의미](docs/OBSERVATION_JOBS.md)

계좌 현황의 **관심종목 관리**에서 조회할 종목을 직접 저장할 수 있습니다. 저장 후 상단 새로고침으로 반영하며 매매 전략/관측 CLI 종목과는 별개입니다. 빈 목록도 유지합니다. [저장·충돌·범위](docs/WATCHLIST.md)
