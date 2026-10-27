# HTH Stock Trading

개인용 국내·미국주식 자동매매 시스템입니다. **현재는 읽기 전용 토스 adapter와 캔들 저장까지 구현했으며, 실제 계좌 연결 검증·전략 실행·Paper 체결·실제 주문은 아직 없습니다.** 기본 dev는 키 없이 실행하고 외부 API를 호출하지 않습니다. `TRADING_MODE=live`는 거부합니다.

## 구성

- `apps/web`: React + Vite + Tailwind CSS, Vercel에 배포할 SPA 안내 화면
- `apps/api`: Fastify, `GET /health/live`만 제공하는 서버
- `apps/worker`: 기본 대기 프로세스와 명시적인 읽기 전용 확인·수집 명령
- `packages/shared`, `broker`, `trading`, `database`: 공통 계약, 토스 adapter, 전략 계약, Drizzle 저장소

설계: [PRD](PRD.md), [아키텍처](ARCHITECTURE.md), [상세 설계](DESIGN.md), [토스 공식 API 조사](docs/TOSS_API.md), [개발 지침](AGENTS.md).

## 로컬 실행

Node.js 24와 Corepack이 필요합니다. pnpm은 packageManager에 고정합니다. 전역 pnpm이 없다면 모든 명령을 `corepack pnpm`으로 실행할 수 있습니다.

```bash
corepack pnpm install --frozen-lockfile
cp .env.example .env
corepack pnpm dev
```

web: http://localhost:5173, API 생존 확인: http://localhost:4000/health/live. 앱은 현재 PostgreSQL 없이 실행됩니다. API의 health는 거래 준비 상태나 DB 연결을 보장하지 않습니다.

개별 실행은 `corepack pnpm dev:web`, `dev:api`, `dev:worker`입니다. 공통 패키지는 실행 전에 빌드됩니다. 개발 중 공통 패키지 변경 후에는 `corepack pnpm build:packages`를 실행하고 앱을 재시작하세요. 서버 설정은 루트 `.env`, 브라우저 공개 설정은 `apps/web/.env.local`에 둡니다. 필요하면 `apps/web/.env.example`을 복사합니다. 현재 web은 API를 호출하지 않습니다.

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

`broker:sync`는 전체 조회가 성공한 뒤 종목과 캔들을 하나의 트랜잭션으로 upsert합니다. 저장 실패는 전체 rollback합니다. 계좌 잔고·키·환율·현재가는 아직 저장하지 않습니다. 반환된 cursor를 사용해 제한된 페이지를 수집하며 이는 전체 과거 데이터 백필 작업이 아닙니다. 현재 저장소는 최신 수집값을 갱신하고 revision 이력은 보존하지 않습니다.

토큰은 worker 명령 내부에서 공유하며 동일 client ID의 다른 프로세스는 같은 PostgreSQL DB를 사용해야 합니다. 별도 DB나 외부 스크립트의 발급까지 막지는 못합니다. 단발성 명령을 종료하면 토큰은 메모리에서 사라지고 다음 실행에 새로 발급합니다. 웹/API는 여전히 토스에 직접 연결하지 않으며 기본 worker에 주기 수집을 자동 활성화하지 않습니다.

**모든 수집 캔들은 `isClosed=false`입니다.** timestamp만으로 봉 확정을 추측하지 않습니다. 세션별 확정·데이터 신선도 검증·revision 정책과 전략용 데이터셋은 다음 단계에서 구현합니다. 조회 성공은 매매 준비 완료를 뜻하지 않습니다.

## 로컬 PostgreSQL과 Docker

```bash
corepack pnpm infra:up
corepack pnpm db:generate
corepack pnpm db:migrate
corepack pnpm infra:down
```

초기 마이그레이션 SQL은 `packages/database/migrations`에 포함되어 있습니다. 스키마를 바꿀 때 `db:generate`로 추가 생성하고 SQL을 검토한 뒤 명시적으로 적용합니다. 현재 스키마는 instruments/candles뿐이며 주문 원장은 설계 단계입니다. Compose 비밀번호는 localhost 개발 전용이며 운영에 재사용하지 마세요. DB volume은 `infra:down`으로 삭제하지 않습니다.

```bash
docker compose -f infra/docker-compose.yml --profile apps up --build
```

API와 대기 worker를 컨테이너로 확인하는 개발용 구성입니다. 상시 운영에는 고정 출구 IP, TLS, 인증, 비밀 관리, 관측·백업 구성을 추가해야 합니다. runtime image 최적화와 운영 배포는 Phase 5 작업입니다.

## Vercel

Git 저장소를 연결하고 Root Directory를 `apps/web`, Framework를 Vite로 선택합니다. `vercel.json`에 빌드·출력 경로와 SPA rewrite가 있습니다. 필요한 공개 API 주소만 `VITE_API_URL`로 설정하고 변경 시 다시 빌드합니다. 토스 키·토큰·계좌 정보는 Vercel 프론트 환경변수에 등록하지 않습니다. 이번 작업에서는 실제 배포를 수행하지 않습니다.

## 다음 작업

1. 키·허용 IP를 설정한 사용자가 읽기 전용 실연결을 확인합니다.
2. 세션별 봉 확정·신선도·revision 및 데이터셋 버전 정책을 구현합니다.
3. 정밀 계산을 도입하고 이동평균 교차 전략·백테스트를 검증합니다.
4. 주문 의도·예약·소유권 원장·상태 머신을 구현한 후 자체 Paper Trading을 연결합니다.
5. 인증과 관리 대시보드를 추가하고, 실거래는 별도 승인 범위에서 진행합니다.
