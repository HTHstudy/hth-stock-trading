# HTH Stock Trading

개인용 국내·미국주식 자동매매 시스템의 설계와 프로젝트 기반입니다. **현재는 실제 증권사 연동·전략 실행·Paper 체결·실제 주문 기능이 없습니다.** API 키 없이 실행하며 `TRADING_MODE=live`는 거부합니다.

## 구성

- `apps/web`: React + Vite + Tailwind CSS, Vercel에 배포할 SPA 안내 화면
- `apps/api`: Fastify, `GET /health/live`만 제공하는 서버
- `apps/worker`: 거래하지 않고 대기하는 프로세스 기반
- `packages/shared`, `broker`, `trading`, `database`: 공통 계약, 읽기 전용 port, 전략 계약, Drizzle 시세 스키마

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

테스트는 안전 모드 설정, 십진 문자열 계약, API health와 주문 endpoint 부재를 확인합니다. 실제 증권사 요청은 하지 않습니다. 공통 패키지와 앱의 운영 산출물은 각각 `dist`에 생성됩니다. 서버는 `corepack pnpm --filter @hth/api start`, worker는 `corepack pnpm --filter @hth/worker start`로 실행합니다.

초기 검증에서 lint·typecheck·테스트 4개·build·포맷·Compose 문법·마이그레이션 SQL 생성을 확인했습니다. API와 웹 프로덕션 미리보기의 HTTP 200, worker의 Paper 대기와 정상 종료도 확인했습니다. API/worker 운영 산출물은 `live` 설정 시 시작을 거부합니다. Docker 이미지 빌드는 현재 환경에서 npm 인증서 체인 오류(`UNABLE_TO_GET_ISSUER_CERT_LOCALLY`)로 완료하지 못했습니다. TLS 검증을 비활성화하지 않았으며, 올바른 CA 신뢰 설정을 갖춘 환경에서 재검증해야 합니다. DB 마이그레이션 적용과 Vercel 배포는 수행하지 않았습니다.

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

1. 공식 명세 기반 DTO fixture·Zod 검증과 읽기 전용 Toss adapter를 추가합니다.
2. worker 단일 token manager, 그룹별 호출 제한, 계좌·시세·환율·시장 캘린더를 연결합니다.
3. 캔들 수집·정규화·저장과 revision 정책을 구현합니다.
4. 정밀 계산을 도입하고 이동평균 교차 전략·백테스트를 검증합니다.
5. 주문 의도·예약·소유권 원장·상태 머신을 구현한 후 자체 Paper Trading을 연결합니다.
6. 인증과 관리 대시보드를 추가하고, 실거래는 별도 승인 범위에서 진행합니다.
