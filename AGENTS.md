# 개발 지침

## 범위와 안전 기본값

- 개인용 국내·미국주식 자동매매 시스템이다. 현재는 읽기 전용 토스 연동과 localhost 대시보드를 제공한다.
- 기본 모드는 `paper`이다. 현재 버전은 `live` 설정 자체를 거부한다.
- 실제 주문 생성·정정·취소 API를 구현하거나 호출하지 않는다. 향후 실거래 구현은 별도 작업으로 진행한다.
- API 키가 존재한다는 이유로 실거래를 활성화하지 않는다. 테스트는 실제 증권사 API를 호출하지 않는다.
- `.env`, 토큰, 계좌 번호, 원본 계좌 응답을 커밋하거나 로그에 남기지 않는다.

## 구조

- `apps/web`: React + Vite SPA, Vercel 배포. 증권사 키 및 DB에 접근하지 않는다.
- `apps/api`: Fastify HTTP 서버. 외부 입력과 환경변수는 Zod로 검증한다.
- `apps/worker`: 읽기 전용 확인·캔들 수집과 대시보드 IPC 실행 entrypoint. 토큰은 worker만 발급한다.
- `packages/contracts`: JSON 계약, 통화·시장·시간 타입, 안전 설정 검증. Node 전용 코드를 넣지 않는다.
- `packages/broker`: 증권사 포트와 읽기 전용 Toss adapter. 외부 DTO는 adapter 안에서만 사용한다.
- `packages/trading`: market-data, strategy, risk, execution, backtest 도메인. 전략은 broker와 DB를 import하지 않는다.
- `packages/database`: Drizzle 스키마와 DB 연결. 금액·수량은 numeric/십진 문자열로 취급한다.
- 각 패키지 공개 export로만 접근한다. 순환 의존와 다른 패키지 내부 경로 접근을 금지한다.

## 프론트엔드

- `src/app`은 실행 환경, `src/pages`는 화면별 slice, `src/shared`는 범용 도구다.
- import 방향은 `app → pages → shared`. 다른 레이어는 `@app/*`, `@pages/*`, `@shared/*` alias로 접근한다.
- slice 간 직접 참조와 공개 entrypoint 우회를 금지한다. 선택 레이어는 실제 중복이 생긴 뒤 도입한다.
- 화면 전용 로직은 해당 page에 둔다. 서버 상태는 TanStack Query v5로 관리한다.
- 실제 자산 snapshot은 localhost 개발 환경에만 제공한다. public bind·production 활성화를 허용하지 않는다. 외부 배포에는 별도 소유자 인증이 필요하다.
- 금액 계산은 worker의 decimal.js에서 수행하고 프론트엔드는 표시만 한다. 차트 좌표 계산만 number를 사용한다.

## 구현과 검증

- TypeScript strict, 명시적인 type import, named export, kebab-case 파일명을 사용한다.
- 비즈니스 로직은 순수 함수로 작성하고 I/O와 분리한다. 불필요한 클래스·서비스·의존성을 추가하지 않는다.
- Toss endpoint/DTO를 추측하지 않는다. `docs/TOSS_API.md`의 공식 OpenAPI/AsyncAPI를 재확인한다.
- token manager는 worker가 소유한다. 실제 연결 명령은 같은 DB에서 client별 advisory lock을 획득한 뒤 실행한다.
- 테스트는 주입한 가짜 fetch만 사용한다. DB 통합 테스트는 localhost의 `hth_readonly_test` 전용 DB에서만 실행한다.
- 캔들은 현재 모두 미확정으로 수집한다. timestamp만으로 `isClosed=true`를 설정하지 않는다.
- 주문 의도는 전송 전 DB에 기록한다. 불확실한 응답에 주문을 무조건 재전송하지 않는다.
- 중복 방지, 부분 체결, 기존 보유분 보호, 재시작 복구는 `DESIGN.md`의 불변조건을 따른다.
- 새 의존성을 추가하면 목적과 대안을 문서에 기록한다.
- 검증 명령: `corepack pnpm lint`, `corepack pnpm typecheck`, `corepack pnpm test`, `corepack pnpm build`, `corepack pnpm format:check`.
- lockfile을 유지한다. 커밋·배포·마이그레이션 실행은 자동으로 수행하지 않는다.
