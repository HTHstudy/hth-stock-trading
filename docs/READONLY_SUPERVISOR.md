# 유한 읽기 전용 관측 감독기

`readonly:supervise`는 계획한 한 번의 관측 자식을 시작하고 절대 종료 기한·취소·정상 종료·저장 증거를 확인한다. 기본은 무접속 미리보기이며 실행 시에도 source 기본값은 demo다. 자동 재시작·재예약·Paper 재개·실주문·DB 마이그레이션을 제공하지 않는다. 새 의존성은 없다.

## 계획과 실행 분리

기존 산출물을 별도로 빌드한 후 사용한다. 명령 자체가 빌드나 환경파일 로딩을 수행하지 않는다. 실행 중 이 명령이 사용하는 빌드는 별도로 고정해야 한다. 오늘 미국 Paper 예약의 빌드는 별도 복사본으로 유지한다.

```bash
# 키/DB/파일/자식 접근 없는 기본 미리보기
corepack pnpm readonly:supervise

# 실제 시작 없이 계획·종목·출처를 결합한 planHash 확인
corepack pnpm readonly:supervise --source=market --symbol=US:AAPL \
  --kind=session --start-at=2026-11-04T20:55:00Z \
  --boundary-at=2026-11-04T21:00:00Z --deadline=2026-11-04T21:10:00Z \
  --interval-seconds=30 \
  --reserved-start=2026-11-04T14:35:00Z --reserved-end=2026-11-04T15:00:00Z

# 별도 명시적인 읽기 전용 코드/lockfile fingerprint 조회
corepack pnpm readonly:supervise --fingerprint
```

실행하려면 검토한 미리보기와 같은 인자에 `--execute --plan-hash=<SUPERVISOR-PLAN-HASH> --build-hash=<BUILD-HASH>`를 추가해야 한다. 계획 도구의 출력 전체나 과거 private 계획 묶음의 hash와는 구분한다. 감독기의 planHash는 계산된 plan·source·단일 instrument를 함께 결합한 값이다. hash는 운용 승인이나 서명이 아니며 조회로 실행하지 않는다.

CLI는 외부 PID·실행 경로·출력 경로·계좌를 받지 않는다. source=market은 종목 하나를 명시해야 하며 demo에는 종목 입력을 허용하지 않는다. 알 수 없는/중복 옵션·live 설정·계획 hash 불일치·차단된 계획·시작 36시간 초과·시작 누락 2분 초과는 자식을 만들기 전에 거부한다. 실패 시 새 토큰/새 자식으로 우회하지 않는다.

## 종료 기한과 소유 자식

1. 대기 전 계획과 빌드 fingerprint를 검증하고 새 UUID의 request.json을 기록한다. 대기는 최대 1초 단위로 나누며 키·DB·토큰을 열지 않는다.
2. 시장 관측은 저장된 Paper 실행 요청도 대기 전/시작 직전에 확인한다. 미종료 요청이 관측 구간과 겹치거나 자료 접근 실패·검증 제외·스캔 상한으로 예약을 확정할 수 없으면 차단한다. 과거의 해석 불가능한 기록도 임의로 지우거나 완료로 바꾸지 않는다. 다른 외부 도구/미등록 예약까지 조회하는 시스템은 아니며 입력한 예약 목록 검토도 필요하다.
3. 시작 직전 시각·취소·빌드를 다시 확인한 뒤 고정 Node/관측 CLI의 자식 하나만 시작한다. 같은 client/DB advisory lock과 token manager는 기존 관측 자식이 소유한다. parent는 실제 API에 연결하지 않는다. 자식 환경에는 PATH/LANG/TZ와 안전한 paper/development만 전달하며 시장 자식만 서버 root .env를 명시적으로 읽는다. NODE_OPTIONS·소유자 세션·Paper 환경·키를 부모에서 복사하지 않는다.
4. 계획의 전체 deadline에서 정리 여유 60초를 뺀 시각에 수집 종료를 시작한다. wall-clock 검사와 별도 타이머로 절전 복귀 후 기한 초과를 확인한다. 관측 완료 전 기한/취소/시계 역행이 발생하면 자신이 직접 spawn한 ChildProcess에만 SIGTERM을 보낸다.
5. 정상 종료는 최대 15초 기다리고 필요 시 같은 자식에만 SIGKILL 후 최대 5초 기다린다. 강제 종료는 실패·childCleanupConfirmed=false이며 후속 실행이 없다. 정상 exit 0 자체도 파일/토큰/잠금·데이터 품질 검증을 대신하지 않는다. OS/PC 강제 종료나 멈춘 파일 I/O를 실시간으로 보장하지 않는다.

수집 타이머가 정리 여유 이전에 도달하면 정상 표본이 일부 남아도 실행 결과는 실패다. samples×interval을 단순 종료 시각으로 사용하지 않는다. 종료 이후 새 날짜에 자동 이월하지 않는다. parent 강제 종료/전원 장애 시 결과 파일이 없을 수 있으며 이를 완료로 해석하지 않는다.

## 세션 경계 재확인

market/session 자식에는 `--expected-session-boundary`를 전달한다. 자식이 같은 broker 잠금을 잡은 뒤 공식 캘린더를 새로 조회하고, 지정한 시장의 previous/today/next business day 중 sessionsKnown인 regular 시작/종료 시각과 정확히 일치할 때만 수집한다. 맞지 않으면 기존 허용 코드 OBSERVATION_SESSION_UNAVAILABLE로 종료한다. regular-only와 함께 사용하지 않으며 경계 양쪽 수집을 허용한다.

이 확인은 캘린더와 예상 경계의 일치다. 실제 경계 전후의 데이터·세션 전환 검증을 통과시킨다는 뜻은 아니다. 별도 초기 캘린더 조회 1회가 생기므로 계획기의 samples×5 source 메서드 수 외에 추가되며 HTTP 수/재시도/공유 요청 예산은 별도 검토한다. TTL 관측에서는 실제 반환 TTL과 사후 expiry 이벤트를 검토하고 계획을 자동 연장하지 않는다.

## 결과와 검증 범위

새 private 경로 `.local-data/readonly-supervisions/<UUID>/`에 request.json·observation/<관측 UUID>/·result.json을 보관한다. 기존 파일을 덮어쓰지 않는다. 결과는 내용 hash와 함께 0600으로 원자적 새 생성한다. stdout 결과에는 PID·경로·키·계좌·원본 로그를 포함하지 않으며 child stdout/stderr는 수집하지 않는다.

정상 child 종료 후 다음을 검사한다.

- 기존 terminal/manifest/journal의 strict schema·hash·집계·순서·종목/출처·요청 횟수·간격·timeout 일치
- 표본 시각의 역행·미래 시각·기한 초과·완료 후 간격 누락 없음, 수집 오류 0
- market 자식의 토큰 파일 manifest/hash 연결·clockUnverified=false·limited=false·inFlight=0
- 종료 시 고정 코드/lockfile fingerprint와 기한 재확인

manifest 8KiB, summary 256KiB, journal 32MiB, 토큰 파일 128KiB 상한과 일반 파일/O_NOFOLLOW·UUID/디렉터리 symlink 검사를 기존 프로세스 검증기에서 공유한다. fingerprint는 컴파일 JS와 lockfile의 변경 검사이며 의존성/OS 전체의 서명 검증은 아니다. 신뢰된 서버 소유자의 private 로컬 자료를 전제하며 동일 UID의 악의적 부모 경로 교체 경쟁까지 원자적으로 차단하지 않는다.

`state=observation-completed`는 관측 프로세스와 저장된 증거의 제한된 검증이다. healthy/closed/blocked를 별도로 보관한다. 현재 결과의 tokenExpiryVerified/sessionBoundaryVerified/paperLedgerCompared는 모두 false다. 자연 토큰 갱신·세션 전환·잠금 해제·Paper 보존은 [장시간 검증 기준](LONG_RUNNING_VALIDATION.md)의 별도 증거로 판정해야 한다. 완료/실패를 주문 권한이나 수익성으로 확대하지 않는다.

## 이번 작업

실제 broker를 호출하거나 새 장시간 관측을 예약하지 않았다. 테스트는 합성 자식/가짜 시계로 기한 정리·강제 종료·대기 취소·시계 역행·증거 없음·hash 변조·완료 자료 연결을 확인한다. 기본 무접속과 위험 옵션/비밀 환경 전달 차단도 검사한다. 기존 미국 Paper 예약은 고정 빌드에서 유지한다. 실제 실행 전에는 전체 예약 기록의 검증 가능 여부와 별도 고정 빌드/원장 보존 기준을 확인해야 한다.

전체 기본 테스트 79파일·485개가 통과했고 DB 통합 102개는 기본 실행에서 제외됐다. 이후 예약 시각 자체를 plan 출력/hash에 포함하는 회귀 검사 1개를 추가하고 영향받는 4파일·33개 테스트를 다시 통과했다. 타입·린트·전체 빌드·포맷 검사를 확인했다. 로컬 기본 CLI 미리보기와 기존 미국 Paper 고정 build hash 보존·예약 프로세스 생존도 별도로 확인했다. 과거 준비/계획 파일은 수정하지 않으며 새 감독기 실행 hash는 새 미리보기에서 확인해야 한다.
