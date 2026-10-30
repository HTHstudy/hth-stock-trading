# 로컬 Docker 운영 기반

`infra/compose.local.yml`은 로컬 PC용 web·api·worker·db 네 컨테이너 구성이다. 기존 `infra/docker-compose.yml`의 개발 DB/볼륨과 분리된 `hth-local` 프로젝트를 사용한다. 클라우드나 외부 네트워크에 공개하는 설정이 아니다. 기존 호스트 `.env`, `.env.owner`, `.local-data`, DB를 자동으로 가져오지 않는다.

## 구성과 기본 동작

| 서비스 | 역할                                           | 외부 공개           |
| ------ | ---------------------------------------------- | ------------------- |
| web    | Caddy + React 정적 빌드, `/api/*`를 API로 전달 | `127.0.0.1:5173`만  |
| api    | 소유자 로그인, 관심종목, 저장된 리포트 조회    | 별도 포트 공개 없음 |
| worker | Node.js 명시적 대기·관측·정지 Paper 서비스     | 없음                |
| db     | 별도 PostgreSQL 17, 영속 데이터 볼륨           | 없음                |

Vite 개발 서버는 이미지에서 실행하지 않는다. React 빌드 파일만 Caddy에 복사한다. `/health/web`은 정적 웹 서버 확인이고 `/api/health/live`는 API 생존 확인이다. worker의 running/idle도 거래 준비 상태를 의미하지 않는다. 새 애플리케이션 라이브러리는 없으며 웹 서빙에 공식 Caddy 이미지를 사용한다.

API의 기존 loopback IP·Host·Origin·소유자 인증 경계를 유지하기 위해 **api만 `network_mode: service:web`으로 web의 네트워크 공간을 공유**한다. 두 컨테이너/프로세스는 별도이며 Caddy는 `127.0.0.1:4000`으로 연결한다. API는 운영 빌드에서 `LOCAL_CONTAINER_MODE=true`, `API_HOST=127.0.0.1`을 명시해야 로컬 파일 서비스를 제공한다. 공개 bind는 거부하고 forwarded IP를 신뢰하지 않는다. Host localhost/127.0.0.1만 Caddy를 통과하며, 공개 도메인·LAN·터널·포트포워딩 용도가 아니다.

이 구성은 API와 web의 네트워크 수명이 연결되는 절충이다. web 이미지를 교체할 때는 API도 함께 재생성해야 한다. `local:up`은 전체를 `--force-recreate --wait`하여 이전 네트워크에 API만 남는 것을 피한다. 실행 중 작업이 있으면 먼저 정상 종료한다. 같은 PC에서 web/API를 무중단으로 독립 배포하는 구조는 아니다.

## 준비·실행

Node 24/Corepack, Docker Engine 또는 Docker Desktop과 Compose가 필요하다. 기본 포트는 개발 화면과 같은 5173이다. **기존 `pnpm dev`가 사용 중이면 먼저 정상 종료**하고 시작한다. 개발 서버를 자동으로 종료하거나 5174로 우회하지 않는다.

```bash
cp infra/.env.local.example infra/.env.local
chmod 600 infra/.env.local
corepack pnpm local:up
corepack pnpm local:status
```

http://127.0.0.1:5173 에 접속한다. 처음에는 소유자 해시가 비어 있으므로 로그인/비공개 기능은 사용 불가 상태다. 기존 해시가 있으면 그 값만 `LOCAL_OWNER_PASSWORD_HASH`에 직접 설정한다. 새 비밀번호를 등록할 때는 다음처럼 기존 파일과 다른 출력 경로를 사용한다.

```bash
corepack pnpm owner:hash --output=../../infra/.env.owner.local
```

생성된 파일의 `OWNER_PASSWORD_HASH=` 뒤 해시만 `infra/.env.local`의 `LOCAL_OWNER_PASSWORD_HASH=` 값에 넣고 `local:up`을 다시 실행한다. 비밀번호 원문은 입력 숨김을 사용하며 env에 넣지 않는다. 기존 파일은 덮어쓰지 않는다. `LOCAL_DB_PASSWORD`도 별도 로컬 설정이다. 최초 초기화 이후 env 비밀번호를 바꾼 것만으로 PostgreSQL 내부 비밀번호가 변경되지는 않는다.

Compose는 기본적으로 시세/Paper 대시보드를 비활성화하고 worker를 `idle`, `executionEnabled=false`로 시작한다. 키만 입력해도 관측·매매가 켜지지 않는다. API/worker 기동은 마이그레이션·계좌 생성·거래 재개를 실행하지 않는다. 명시적 `idle/observe/paper` 선택과 상태 조회는 [worker 서비스 운영](WORKER_SERVICE.md)을 따른다. Paper 서비스는 항상 정지 상태로 시작한다.

새 DB 볼륨은 `hth_trading`과 Paper 전용 `hth_readonly_test`를 분리하며 Paper 역할 `hth_test`는 superuser/DB 생성/역할 생성 권한이 없다. API/worker는 같은 비밀번호 설정에서 내부 `db:5432` URL을 구성한다. DB 호스트 허용 확장은 명시적 production 로컬 컨테이너 모드에만 적용하며 기존 localhost 전용 테스트 검증은 유지한다. `LOCAL_PAPER_DB_PASSWORD`도 최초 설정 후 env 변경만으로 내부 비밀번호가 바뀌지 않는다.

기존 로컬 Compose 볼륨에는 초기화 스크립트가 자동 재실행되지 않는다. worker/쓰기 작업을 멈추고 DB·파일 백업을 완료한 뒤 **해당 로컬 프로젝트만 대상으로** 아래 명령을 명시적으로 실행한다. 기존 역할 권한이나 DB 소유자가 다르면 실패하며 자동 수정하지 않는다. 기존 호스트 개발 DB에는 실행하지 않는다.

```bash
docker compose --env-file infra/.env.local -f infra/compose.local.yml \
  exec -T db sh /docker-entrypoint-initdb.d/10-paper.sh
```

실제 시세로 연결하기 전에는 기존 관측과 토큰 소유자를 종료하고 모든 동일 client 프로세스가 **같은 broker 잠금 DB**를 사용하는지 확인해야 한다. 별도 DB를 새로 만든 것만으로 호스트 관측과 잠금이 공유되지 않는다. 현재 미국장 예약은 기존 환경에서 유지하며 이 구성으로 이전하지 않았다.

## 사내 CA가 필요한 빌드

표준 인증서 신뢰 환경은 위 명령만 사용한다. 사내 TLS 검사 환경에서 `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`가 발생하면 신뢰된 **공개 CA bundle**을 BuildKit secret으로 제공한다.

```bash
LOCAL_BUILD_CA_FILE=/absolute/path/trusted-public-ca.pem \
  docker compose --env-file infra/.env.local \
  -f infra/compose.local.yml -f infra/compose.ca.yml \
  up -d --build --force-recreate --wait
```

Dockerfile은 선택적 `npm_ca` secret을 의존성 설치 단계에서만 읽는다. `NODE_EXTRA_CA_CERTS`로 기본 공개 루트를 유지하면서 추가 신뢰한다. CA 파일·개인키·환경 파일을 이미지에 복사하지 않고 TLS 검증을 끄지 않는다. `.dockerignore`는 모든 깊이의 env 파일, `.local-data`, 키 파일을 제외한다. 실제 broker를 연결할 때 런타임 CA 신뢰가 추가로 필요한지는 별도 확인해야 한다.

## 데이터 보존·종료·재시작

`postgres_data`는 DB, `app_data`는 설정/리포트, `dashboard_socket`은 비공개 공유 소켓용이다. 프로젝트 이름에 따라 실제 volume 이름이 정해진다. api/worker는 같은 UID 1000을 사용하고 app_data와 소켓 디렉터리는 0700으로 초기화한다. 소켓 volume 자체는 거래 기록이 아니며 강제 종료 후 남은 소켓을 자동 삭제하지 않는다.

```bash
corepack pnpm local:down
corepack pnpm local:up
```

`down`은 볼륨을 지우지 않는다. `down -v`, `docker volume prune`, Docker Desktop 데이터 초기화는 영속 데이터를 지울 수 있으므로 운영 절차로 사용하지 않는다. 새 프로젝트 이름을 쓰면 새 볼륨을 보게 되며 데이터가 이전되는 것은 아니다.

`unless-stopped`는 Docker가 실행 중일 때 컨테이너 재시작 정책이다. PC 로그인 시 Docker Desktop 시작/절전 방지는 OS 운영 설정으로 별도 관리한다. Docker만으로 PC 절전·정전·Docker daemon 중단을 해결하지 않는다. [절전과 관측 공백](MARKET_OBSERVATION.md)을 따른다. api 재시작 후 메모리 로그인 세션은 만료되어 다시 로그인해야 한다.

## DB 백업과 빈 DB 복원 훈련

```bash
corepack pnpm local:backup --env-file=infra/.env.local --database=broker
corepack pnpm local:backup --env-file=infra/.env.local --database=paper
# 다른 검증 프로젝트라면 --project=hth-local-check
# 출력 위치를 고정하려면 --output=.local-data/backups/my-backup.dump
```

Node 도구가 실행 중 db 컨테이너의 `pg_dump --format=custom --no-owner --no-acl`을 호출한다. 임시 파일 0600으로 저장한 뒤 기존 파일을 덮어쓰지 않고 공개한다. 대상 종류·파일 경로와 SHA-256만 출력하고 dump 본문/접속 자격증명/원본 stderr는 로그에 남기지 않는다. 실패한 임시 파일은 정리한다. project는 hth-local 또는 그 검증용 접미 이름만 허용한다. 백업 파일을 다른 저장 장치에도 별도로 보관한다.

다음은 **운영 DB를 덮어쓰지 않는 빈 복원 확인용 DB** 예시다. 기존 이름이 있으면 자동 삭제하지 않고 다른 새 이름을 사용한다. 명령은 저장소 루트에서 실행한다.

```bash
docker compose --env-file infra/.env.local -f infra/compose.local.yml \
  exec -T db createdb -U hth -T template0 hth_restore_check

docker compose --env-file infra/.env.local -f infra/compose.local.yml \
  exec -T db pg_restore -U hth -d hth_restore_check \
  --exit-on-error --no-owner --no-acl < .local-data/backups/my-backup.dump
```

Paper 백업은 별도의 새 DB를 `createdb -U hth -O hth_test -T template0 hth_restore_paper_check`로 만들고 `pg_restore -U hth_test -d hth_restore_paper_check --exit-on-error --no-owner --no-acl`로 복원한다. `--database` 생략 시 broker만 백업되므로 두 DB를 각각 보관한다.

복원된 테이블/행을 확인하고 계좌·설정·일일 손실·이력 정합성을 별도로 검증한다. `pg_dump`는 PostgreSQL 자체의 일관된 snapshot이며 파일 볼륨과의 공동 snapshot은 아니다. 실제 전체 복구를 하려면 worker/쓰기 요청을 먼저 중단하고 DB와 app_data를 같은 운영 시점에 백업한다. 소유자 해시 등 env도 별도 비밀 저장소에서 복구한다.

파일 볼륨은 쓰기 작업을 중단한 후 다음처럼 보관할 수 있다. 파일에는 비공개 데이터가 있을 수 있으므로 권한과 별도 보관 위치를 관리한다.

```bash
umask 077
mkdir -p .local-data/backups
docker compose --env-file infra/.env.local -f infra/compose.local.yml \
  exec -T api tar -czf - -C /app .local-data > .local-data/backups/app-data.tar.gz
```

소켓 파일은 백업/이관하지 않는다. 클라우드로 옮길 때는 새 서버에 같은 이미지/Compose를 준비하고 DB dump·app_data·비밀 설정을 복구한다. UID/파일 권한과 토스 출구 IP를 재확인한 뒤 정지 상태에서 검증한다. 외부 접속 전에는 HTTPS·Secure cookie·프록시/접근 정책을 별도 구현해야 한다. 현재 HTTP/loopback 설정 그대로 인터넷에 공개하지 않는다.

## 검증 범위

개발 중 기존 호스트 5173·DB·예약은 유지하고 별도 `hth-local-check` 프로젝트/59080 포트/임시 자격증명으로 검증한다. 실제 키나 실제 계좌를 사용하지 않는다. 운영 기본 포트를 바꾼 것이 아니며 검증 종료 후 해당 컨테이너는 정리한다.

파일 복원은 쓰기 작업을 중단하고 **새 볼륨**으로 먼저 훈련한다. 아래 새 이름이 기존 볼륨인지 확인하고, 기존 운영 볼륨에 바로 덮어쓰지 않는다. image의 초기 디렉터리 소유권은 UID 1000이며, 보존한 신뢰된 자체 백업만 사용한다.

```bash
docker run --rm -i --network none \
  --mount source=hth-local-restore_app_data,target=/app/.local-data \
  hth-local-backend tar -xzf - -C /app < .local-data/backups/app-data.tar.gz
```

2026-10-30 검증에서 서버·웹 이미지를 실제 빌드했고, 별도 프로젝트의 4개 컨테이너 기동/전체 재생성, HTTP 로그인·미인증/교차 Origin 차단, 관심종목·DB 행 보존, 이전 로그인 세션 무효화, worker paper/idle을 확인했다. DB dump의 새 빈 DB 복원과 파일 archive의 새 볼륨 복원, 기존 백업 덮어쓰기 거부·0600 권한도 통과했다. 동일 UID 1000/소켓 디렉터리 0700/볼륨 공유와 이미지 내 env·빌드 CA 부재도 확인했다. 전체 406개 테스트와 타입·린트·빌드·포맷 검사를 통과했다. 이 검증은 기존 계좌의 Paper 운영이나 실제 broker 연결 검증을 대신하지 않는다.

추가 서비스 검증은 `hth-local-worker-check`/59081에서 실제 키 없이 수행했다. 합성 부분 체결 후 잔고·소유권·주문/체결 보존, 정지 부팅·긴급 정지, DB 장애 시 failed 및 DB 복구만으로 재시도하지 않음, 별도 Paper 백업의 새 DB 복원, API/worker 사이 advisory lock 경합, 합성 관측 완료와 동일 요청 재실행 차단을 확인했다. 전체 테스트는 418개가 통과했다. 합성 검증은 실제 시장 데이터 품질이나 수익성 검증을 의미하지 않는다.
