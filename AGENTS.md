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
- `apps/worker`: 읽기 전용 확인·캔들 수집·대시보드 IPC와 별도 Paper 실행기. 기본 main은 대기하며 토큰은 읽기 전용 worker만 발급한다.
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
- 금액 계산은 worker·trading의 decimal.js에서 수행하고 프론트엔드는 표시만 한다. 차트 좌표 계산만 number를 사용한다.

- Paper 화면/API는 `docs/PAPER_DASHBOARD.md`를 따른다. 기본 비활성, loopback·전용 테스트 DB·서버 고정 계좌만 허용한다. 조회 DTO에서 계좌 ID·lease token·원본 요청/decision/감사 상세를 제거한다. 긴급 정지는 DB 정지 기록이며 정리 완료·자동 청산·재개를 의미하지 않는다. 조회로 worker를 시작하거나 사용자 DB 마이그레이션을 적용하지 않는다.

- 소유자 인증은 `docs/OWNER_AUTH.md`를 따른다. 비공개 API는 인증 미설정/미로그인 시 차단하며 세션은 서버 검증 cookie로만 식별한다. 비밀번호·해시·세션을 로그/브라우저 저장소에 넣지 않는다. `.env.owner`는 서버 전용이며 등록으로 거래를 재개하지 않는다.
- 전략 변경은 `docs/STRATEGY_SETTINGS.md`를 따른다. 전략 revision CAS·불변 변경 이력·정지/epoch를 함께 커밋한다. worker는 DB 정의/hash를 사용하고 변경 시 멈춘다. 활성 토글로 같은 봉의 주문을 재생성하지 않는다.
- 전략 이력 조회는 `docs/STRATEGY_HISTORY.md`를 따른다. 서버 고정 계좌·읽기 전용 snapshot·내용 hash 검증을 유지하고 기록 없는 과거 조건을 추정하지 않는다. 조회를 복원·재개로 확장하지 않는다.
- Paper 자산 이력은 `docs/PAPER_EQUITY.md`를 따른다. 관측/체결/대사 이벤트와 평가값을 원자적으로 기록하고 최초 기준을 유지한다. 수동 보유분 포함 계좌 자산 변동률을 전략 수익률로 표시하지 않는다. 조회로 평가를 생성하지 않는다.

## 구현과 검증

- TypeScript strict, 명시적인 type import, named export, kebab-case 파일명을 사용한다.
- 비즈니스 로직은 순수 함수로 작성하고 I/O와 분리한다. 불필요한 클래스·서비스·의존성을 추가하지 않는다.
- Toss endpoint/DTO를 추측하지 않는다. `docs/TOSS_API.md`의 공식 OpenAPI/AsyncAPI를 재확인한다.
- token manager는 worker가 소유한다. 실제 연결 명령은 같은 DB에서 client별 advisory lock을 획득한 뒤 실행한다.
- 테스트는 주입한 가짜 fetch만 사용한다. DB 통합 테스트는 localhost의 `hth_readonly_test` 전용 DB에서만 실행한다.
- broker 원본 봉은 미확정으로 반환한다. worker가 `docs/MARKET_DATA_POLICY.md`의 세션·대기·재관측 증거로만 종료 플래그를 설정한다.
- 전략 입력은 `prepareStrategyData`를 거친다. 과거 isClosed 플래그·만료된 dataQuality 보고서를 실행 승인으로 사용하지 않는다.
- 과거 입력은 `docs/HISTORICAL_DATASETS.md`의 커버리지·관측 증거와 hash를 보존한다. revision·동결 데이터셋을 수정·삭제하거나 최신 시세로 바꿔 읽지 않는다. 수집본 재현성과 point-in-time 정확도를 구분한다.
- 백테스트는 `docs/BACKTESTING.md`의 정보 가용 시각과 다음 체결 가능 시가를 따른다. 전략에 미래 봉을 전달하거나 같은 봉 종가에 체결하지 않는다. 비용·체결 가정과 dataset/결과 hash를 보존한다. 합성 데모 수익률을 실제 성과로 표시하지 않는다.
- 리포트 조회는 localhost에서 고정 디렉터리의 schema·hash 검증본만 제공한다. 브라우저 입력으로 파일 경로를 받지 않으며 조회를 전략 재실행이나 주문 권한으로 확장하지 않는다.
- Paper 리스크는 `docs/PAPER_RISK.md`를 따른다. canReserve와 데모 결과는 실행 권한이 아니다. DB 예약은 최신 snapshot/version·정지 epoch·영구 중복 키와 같은 트랜잭션에서 검증해야 한다. 수동/타 전략 소유분과 이미 예약한 현금·수량을 사용하지 않는다.
- Paper 원장은 `docs/PAPER_LEDGER.md`를 따른다. 의도 기록을 먼저 커밋하고, 모든 자원/제어 변경은 계좌 행 잠금을 공유한다. 신호 키와 원본 요청을 재사용·수정하지 않는다. READY는 예약 기록이며 전송/체결 권한이 아니다. 내부 합성 체결은 `docs/PAPER_FILLS.md`의 새 quote·lease/epoch·잔량·누적 비용 검사를 거쳐 같은 트랜잭션에서 현금·소유권·원가·체결을 반영한다. 초기 보유분은 수동 소유이고 새 worker는 정지·복구 상태로 시작한다.
- Paper 실행기는 `docs/PAPER_WORKER.md`를 따른다. 기본 resume=false, 계좌별 단일 lease/heartbeat, 겹치지 않는 tick, 새 소유자의 복구·관측을 요구한다. 종료 시 진행 중 작업을 기다린 뒤 같은 token의 잔량만 정리한다. 일일 손실을 재시작으로 초기화하지 않는다. 합성 CLI는 별도 테스트 DB만 사용하며 실제 시세·주문에 자동 연결하지 않는다.
- 실제 시세 Paper CLI는 `docs/PAPER_MARKET_SOURCE.md`를 따른다. `paper-market-*` 계좌·전용 테스트 DB와 기존 토큰 잠금 DB를 분리하고 기본 정지/1회 관측으로 시작한다. 초기화/마이그레이션과 재개를 한 명령에서 결합하지 않는다. broker 수명 취소와 진행 중 source 정리 후에 토큰 잠금을 해제한다. 계좌 data_source는 생성 시 명시하며 변경하지 않는다. 기존 미확인 계좌는 조회/정지만 허용한다. worker lease/관측과 원장 의도/예약/체결의 출처를 검사한다. 대시보드는 서버의 synthetic/market 선택과 DB 출처가 일치해야 하며 출처를 브라우저에서 받지 않는다.
- 휴장/거래일 검토는 `docs/PAPER_SESSIONS_REVIEW.md`를 따른다. 확인된 휴장은 평가 시각을 위조하지 않고 예약 정리·정지 후 대기한다. 개장/검토 승인으로 자동 재개하지 않는다. 일일 검토는 만료/대상일/version/lease/epoch와 신선한 전체 보유분 quote를 검사하고 이전 손실을 이월한다. 승인/평가/이력을 원자적으로 기록하며 실제 주문을 실행하지 않는다.
- 읽기 전용 관측은 `docs/MARKET_OBSERVATION.md`를 따른다. 시장 품질과 계좌/매매 준비 검사를 구분하며 관측으로 Paper 원장·업무 DB를 변경하지 않는다. 토큰 잠금은 수집 정리까지 유지한다. 리포트에는 검증된 메타데이터·허용된 오류 코드만 저장하고 원본 시세·계좌·인증 정보를 남기지 않는다.
- 관측 리포트 조회는 고정 루트/UUID와 공통 strict 계약을 사용한다. terminal/journal 해시·합계·순서·종목 집합을 검증하고 미완료를 정상으로 표시하지 않는다. 크기/스캔 상한과 소유자/localhost 경계를 유지한다. Markdown·사용자 파일 경로를 제공하지 않으며 조회로 관측/거래를 시작하지 않는다.
- 관측 예약 조회는 `docs/OBSERVATION_JOBS.md`를 따른다. 예약 기록·종료 로그와 프로세스 생존/데이터 품질을 구분한다. 종료 로그가 없다고 실행 중·실패로 추정하지 않는다. PID·원본 로그·경로를 응답하지 않으며 조회를 재예약·취소로 확장하지 않는다.
- 관심종목은 `docs/WATCHLIST.md`를 따른다. 대시보드 조회 목록만 저장하고 Paper 전략/보유분/관측 CLI를 변경하지 않는다. 원자적 파일 교체·배타적 잠금·revision CAS를 유지하고 빈 목록을 기본값으로 복원하지 않는다. 저장은 조회 snapshot/진행 작업을 무효화하지만 새 시세 수집을 시작하지 않는다. 늦은 응답을 폐기하며 불확실한 저장을 자동 재시도하지 않는다.
- 주문 의도는 전송 전 DB에 기록한다. 불확실한 응답에 주문을 무조건 재전송하지 않는다.
- 중복 방지, 부분 체결, 기존 보유분 보호, 재시작 복구는 `DESIGN.md`의 불변조건을 따른다.
- 새 의존성을 추가하면 목적과 대안을 문서에 기록한다.
- 검증 명령: `corepack pnpm lint`, `corepack pnpm typecheck`, `corepack pnpm test`, `corepack pnpm build`, `corepack pnpm format:check`.
- lockfile을 유지한다. 커밋·배포·마이그레이션 실행은 자동으로 수행하지 않는다.
