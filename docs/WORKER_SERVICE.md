# Worker 서비스 운영

worker의 기본 실행은 `idle`이다. 별도 작업을 명시해야 자식 CLI를 실행하며 실제 주문 API는 제공하지 않는다. 컨테이너 재시작과 거래 재개를 분리한다. 서비스화는 기존 미국장 관측 예약을 변경하거나 이전하지 않는다.

## 모드와 수명

| LOCAL_WORKER_MODE | 동작                            | 재시작 시                      |
| ----------------- | ------------------------------- | ------------------------------ |
| idle              | 상태 heartbeat만 기록           | idle                           |
| observe           | 지정 횟수의 관측 CLI 실행       | 소비된 UUID면 awaiting-request |
| paper             | 준비된 계좌의 Paper worker 실행 | 항상 resume=false, 정지/복구   |

`LOCAL_WORKER_SOURCE` 기본값은 `synthetic-only`이다. `toss-readonly`를 명시해야 실제 읽기 전용 source를 선택한다. 키 입력만으로 모드는 바뀌지 않는다. `WORKER_RESUME=true`는 거부하며 서비스 명령에는 `--resume`, `--prepare`, `--initialize`를 넣지 않는다. 관측 종료/실패와 Paper 실패 이후 부모 프로세스는 결과와 heartbeat를 유지한다. DB가 복구됐다고 자식 프로세스를 다시 실행하지 않는다.

SIGTERM은 자식에게 전달하고 진행 중 정리와 종료를 기다린다. 강제 종료·PC 절전·정전에서는 정리 완료를 보장하지 않으며 기존 원장의 lease/epoch/복구 정책이 적용된다. 컨테이너 running은 관측 정상이나 거래 허용을 뜻하지 않는다. 하나의 app_data에는 상태 작성자 worker를 하나만 실행한다.

## 합성 Paper의 명시적 준비

기존 개발 DB 대신 로컬 Compose의 전용 `hth_readonly_test`를 사용한다. 생성된 새 `hth_test` 역할은 관리 권한을 갖지 않으며 실행 전에 실제 접속 DB/사용자/권한을 검사한다. 기존 볼륨의 역할 준비는 [로컬 운영](LOCAL_OPERATIONS.md)을 먼저 따른다.

worker가 idle인 상태에서 새 계좌에만 다음 명령을 실행한다. 기존 계좌는 재초기화하지 않으며 명령은 거래를 재개하지 않는다.

```bash
corepack pnpm local:paper:prepare --initialize --prepare --account=paper-demo-local-check
```

`--prepare`는 전용 DB에 스키마를 적용하는 명시적 선택이다. 마이그레이션은 부팅이나 조회에서 수행하지 않는다. 가상 초기 자금과 이동평균 1/2 전략은 합성 검증용이며 투자 설정이 아니다. 준비 후 `infra/.env.local`에서 다음을 선택한다.

```dotenv
LOCAL_WORKER_MODE=paper
LOCAL_WORKER_SOURCE=synthetic-only
LOCAL_PAPER_ACCOUNT_ID=paper-demo-local-check
LOCAL_PAPER_KIND=synthetic
LOCAL_PAPER_DASHBOARD_ENABLED=true
```

`local:up`으로 설정을 반영하면 worker가 계좌 소유권을 확보하고 복구/관측하되 정지 상태로 남는다. 대시보드 정지는 DB 정지 기록이며 청산·재개 버튼이 아니다. 거래 실행 검증은 기존 별도 합성 리허설을 사용한다. Paper 서비스의 상시 자동 재개는 이번 범위에 없다.

## 합성 관측과 중복 실행 차단

```dotenv
LOCAL_WORKER_MODE=observe
LOCAL_WORKER_SOURCE=synthetic-only
LOCAL_WORKER_SYMBOLS=KR:005930
LOCAL_WORKER_SAMPLES=2
LOCAL_WORKER_INTERVAL_SECONDS=10
# node -e 'console.log(crypto.randomUUID())'로 만든 새 UUID
LOCAL_WORKER_REQUEST_ID=
```

빈 요청 UUID는 거부한다. 실행 전에 app_data/runtime에 요청 UUID를 배타적으로 기록한다. 같은 UUID는 성공·실패·중단 여부와 관계없이 재사용하지 않는다. 완료 후 컨테이너를 재시작해도 새 관측은 생성되지 않으며 `awaiting-request`로 남는다. 새 작업은 새 UUID와 명시적 설정 반영이 필요하다. 요청 기록을 삭제해 재시도를 우회하지 않는다. app_data 백업/이관에 이 기록도 포함한다. 이는 단일 worker의 재실행 방지이며 분산 작업 큐나 실주문 exactly-once 보장이 아니다.

실제 관측 설정은 정규장 단일 시장·최대 5종목을 요구한다. 호스트/컨테이너가 같은 broker 잠금 DB를 사용하고 기존 token owner가 종료됐는지 먼저 검토한다. 별도 로컬 DB 생성으로 기존 호스트 관측의 잠금을 공유할 수 없다. 런타임 CA와 등록 출구 IP도 재확인해야 한다. 실제 키를 넣는 것과 실제 시세 운용 검증 통과는 별개이며 이번 서비스 검증에서는 broker를 호출하지 않았다. 실제 시세 Paper 계좌 준비는 기존 별도 계획/CLI 정책을 따르며 합성 준비 명령으로 생성하지 않는다.

## 상태 API와 화면

소유자 인증이 필요한 `GET /v1/worker`는 고정 위치의 `worker.json`만 읽는다. 화면은 관측 페이지의 worker 상태에서 확인한다. 파일이 없거나 schema/크기/경로 검증에 실패하면 unavailable이다. 계좌 ID·접속 URL·토큰·원본 오류는 응답하지 않는다. 조회로 worker·관측·마이그레이션을 시작하지 않는다.

heartbeat가 45초 넘게 지연되면 stale이며 시계 역전/미래 시각은 clock-unverified이다. 작업 진행은 별도로 마지막 진행 시각과 간격을 검사한다. 지연 기준은 `간격 + 10초 + max(30초, 간격)`이다. 최근 heartbeat만으로 시세가 신선하다고 표시하지 않는다. paused 진행 보고는 정지 worker의 관측 루프 보고이며 실행 허가가 아니다. 미국장/국내장 품질은 기존 관측 리포트로 판단한다.

DB pool의 idle 연결 오류는 원본 Error/client 대신 고정 코드 `DATABASE_IDLE_CONNECTION_LOST`만 기록한다. 쿼리 실패와 broker lease 연결 상실은 기존 실패/취소 경로로 전달한다. [node-postgres pool 오류 정책](https://node-postgres.com/apis/pool)을 따른다.

## 검증과 남은 범위

전용 Docker 프로젝트에서 합성 부분 체결을 만든 뒤 정지 부팅·재시작, 잔고/소유권/주문/체결 보존, 긴급 정지, DB 중단 시 실패 및 복구 후 자동 재시도 차단, Paper 백업의 새 DB 복원, broker 잠금 경합, 합성 관측 완료 및 동일 UUID 재실행 차단을 확인했다. 실제 증권사 API는 호출하지 않았다. 테스트 418개가 통과했다. 앱 의존성은 추가하지 않았다.

실제 시세 Paper 운용은 미국장 관측 증거 검토, 기존 토큰 잠금 DB 연결 계획, 계좌/한도/전략 검토, 명시적 제한 실행이 남았다. 실주문과 외부 배포는 구현/실행하지 않았다.
