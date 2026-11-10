# 일회용 PostgreSQL 권한 실험

[증거 확보 가능성 검토](PAPER_AUTHORITY_EVIDENCE_FEASIBILITY.md)의 A 작업을 구현한다. 실제 PostgreSQL 17에서 접속·세션·역할의 서로 다른 수명을 재현하는 **폐기 가능한 테스트 fixture**다. 실제 운영 DB/계좌·권한 폐기·원본 증거·예약 예외·Toss·Paper 실행과 연결하지 않는다. 실험 통과는 운영 환경의 fence 확인서가 아니다.

## 실행과 대상 제한

Node 24, 빌드된 공통/database 패키지, 로컬 Docker Engine/Desktop과 미리 준비된 `postgres:17-alpine` 이미지가 필요하다. 이미지는 자동으로 pull하지 않는다. 지원하는 daemon은 `/var/run/docker.sock`의 로컬 Unix socket이다. 원격 Docker·다른 context·Windows named pipe를 선택하는 옵션은 제공하지 않는다.

```bash
corepack pnpm build:packages

# 기본: 접속/컨테이너 생성 없는 미리보기
corepack pnpm db:authority:lab

# 자신이 새로 만드는 일회용 DB에서만 실험
corepack pnpm db:authority:lab --execute
```

`--execute` 하나만 허용한다. 사용자 URL·계좌·원본 파일·기존 컨테이너·apply/resume·SQL·출력 경로는 받지 않는다. TRADING_MODE는 paper/default만 허용한다. 환경파일·TEST_DATABASE_URL·DB/증권사 자격은 실행 대상을 정하는 데 사용하지 않는다. 현재 shell의 Docker context/DOCKER_HOST도 사용하지 않고, 빈 임시 Docker 설정 디렉터리와 명시적 local socket으로 명령을 실행한다.

매번 새 UUID 이름과 nonce label을 가진 컨테이너를 `create`한다. 충돌한 이름을 재사용/삭제하지 않는다. 기존 마운트·볼륨을 연결하지 않고 PostgreSQL data는 256MiB tmpfs에 둔다. 임시로 생성한 가짜 비밀번호와 임의의 loopback 공개 포트만 사용한다. 시작 후 receipt의 컨테이너 ID·nonce·127.0.0.1 포트·tmpfs 설정/추가 마운트 부재를 확인한 뒤에만 접속한다. Docker daemon이 제공하는 receipt는 이번 실험의 대상 바인딩이며 악의적인 관리자나 운영 환경의 전체 격리까지 인증하지 않는다.

DB 이름은 hth_readonly_test, 관리자 fixture는 hth_test다. 역할 동작을 시험하기 위해 이 **새 컨테이너 내부에만** 비관리 legacy/alternate fixture 역할을 만든다. hth_test는 이 컨테이너 초기화를 위한 관리자이며 실제 서비스 역할의 권한을 변경하지 않는다. 스키마는 실험용 단일 테이블뿐이고 애플리케이션 마이그레이션이나 Paper 계좌를 만들지 않는다. max_prepared_transactions=10도 이 컨테이너에만 적용한다.

## 재현한 7가지 조건

| 검사                                   | 성공으로 기록하기 전에 확인하는 실제 fixture 동작                                                                                |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| passwordRotationKeepsExistingSession   | 비밀번호 교체 후 옛 비밀번호의 신규 인증은 28P01, 새 비밀번호 접속은 성공, 기존 idle 세션의 조회는 계속 성공                     |
| publicGrantBypassesDirectRevoke        | 역할의 직접 CONNECT grant를 제거해도 PUBLIC grant가 남아 있으면 새 접속 성공                                                     |
| connectRevocationKeepsExistingSessions | PUBLIC CONNECT까지 제거하면 신규 접속은 42501, 기존 idle/idle in transaction 세션의 조회는 성공하고 두 상태가 관리 조회에 존재   |
| terminationRollsBackOpenTransaction    | 직접 만든 두 세션만 종료하고 실제 세션 부재·미커밋 UPDATE rollback·기준값 보존을 확인                                            |
| preparedTransactionOutlivesSessions    | 준비 트랜잭션 생성 후 세션 종료·CONNECT 차단·NOLOGIN으로 신규 접속 28000을 확인해도 준비 상태 1건이 남고 미커밋 행은 보이지 않음 |
| noLoginDoesNotBlockSetRole             | LOGIN 불가인 legacy 역할로 alternate가 명시적 SET ROLE을 수행하고 fixture 행을 변경할 수 있음                                    |
| membershipRemovalBlocksNewSetRole      | membership 제거 후 새 alternate 세션에서 SET ROLE이 42501로 거부됨                                                               |

예상한 SQLSTATE와 다른 timeout·네트워크 오류·오입력·검사 누락은 통과로 분류하지 않는다. 준비 상태는 실험이 직접 만든 정확한 GID 하나만 명시적으로 ROLLBACK PREPARED하고 잔존 0건을 확인한다. 운영 collector가 발견한 준비 트랜잭션을 자동 정리하는 기능은 아니다. 다른 세션·트랜잭션·DB·역할을 검색해 수정하지 않는다.

공식 근거는 CONNECT가 접속 시작 때 검사된다는 [권한 문서](https://www.postgresql.org/docs/17/ddl-priv.html), 준비 상태가 세션과 분리되는 [PREPARE TRANSACTION](https://www.postgresql.org/docs/17/sql-prepare-transaction.html), 종료 신호와 실제 종료를 구분하는 [세션 제어](https://www.postgresql.org/docs/17/functions-admin.html#FUNCTIONS-ADMIN-SIGNAL)를 따른다. 이번 재현은 PostgreSQL 동작의 fixture 검사이며 실제 권한 범위 완전성이나 지속 통제를 검증하지 않는다.

## 결과·실패·정리

stdout의 state=passed는 위 fixture 동작과 정리가 완료됐다는 뜻이다. operatingEvidence/policyApplied/reservationExceptionsCreated/executionEnabled/canResume는 항상 false다. 계좌·PID·URL·비밀번호·원본 SQL/오류·관리 출력은 결과에 포함하지 않는다. 고정 실패 단계 코드만 출력하고 exit 1로 종료한다. 미리보기/통과는 exit 0이다.

정상/실험 실패 시 자신이 얻은 정확한 container ID만 제거하고 임시 Docker 설정을 정리한다. 정리 실패를 통과로 덮지 않는다. create 응답이 불확실해 ID를 얻지 못한 경우 이름을 추측해 삭제하거나 재시작하지 않는다. 프로세스 강제 종료·전원 장애·daemon 장애 시 잔존 자원 정리는 보장하지 않는다. 이때는 실패로 남기고 소유자가 Docker 관리 화면에서 `hth.authority-lab` label이 있는 테스트 자원만 검토한다. 자동 재시도·전체 container/volume prune·기존 서비스를 중지하는 명령은 없다.

## 자동 검증과 CI 영향

단위 테스트는 CLI 미리보기/잘못된 인자에서 Docker가 호출되지 않는지, 환경파일/민감값 비노출, remote Docker 환경 무시, 위조/누락 receipt 거부, 불확실 create에서 추측 삭제 금지, 잘못된 receipt 뒤 소유 ID 정리를 검사한다. 이 경로는 가짜 Docker 실행 파일만 사용한다.

`authority-lab.integration.test.ts`는 기존 통합 suite처럼 TEST_DATABASE_URL이 설정됐을 때 실행한다. 먼저 기존 localhost/hth_readonly_test/hth_test 형식을 검증하지만 **그 URL에 연결하거나 권한을 변경하지 않는다**. 실험 함수가 별도 컨테이너/포트를 생성한다. 통합 suite가 활성인데 Docker/image/socket이 없으면 실패하며 조용히 통과/skip하지 않는다. TEST_DATABASE_URL이 없는 단위 실행에서는 DB 통합을 생략한다.

GitHub Actions의 현재 Ubuntu Docker runner와 PostgreSQL 17 service 이미지 캐시를 사용하며 새 서비스·의존성·관리 secret은 추가하지 않는다. pre-commit은 관련 단위만, verify:ci는 이 통합 실험까지 실행한다. DB/daemon 권한 변경 테스트를 기존 공유 CI PostgreSQL 서비스 안에서 하지 않는 이유다. 전체 검사는 새 전용 일반 테스트 DB와 이 실험의 별도 컨테이너를 동시에 사용한다.

실제 운영 DB에서 권한을 폐기하는 CLI/collector, 지속 통제, 전체 runtime/broker 범위 검증은 여전히 미구현이다. 기존 a407 차단·과거 이력·계좌·예약·재개 정책을 유지한다. 다음 작업은 구실행·관리 주체·새 secret 공급 경계를 구분하는 격리 설계다.

## 2026-11-10 검증 결과

CLI/대상 검증 단위 29개와 새 일회용 Docker DB 통합 1개가 통과했다. root 미리보기·명시적 execute의 7조건 및 정상 정리도 확인했다. 별도 일회용 localhost 전용 테스트 DB에서 최종 로컬 verify:ci는 138파일·1,275개 테스트(테스트 구간 66.66초), 포맷·린트·타입·전체 빌드를 통과했고 두 Compose 설정·문서 링크·diff 검사도 통과했다. 원격 CI나 실제 운영 권한 검증 결과는 아니다. 신규 의존성/마이그레이션·실제 주문 기능은 추가하지 않았다.
