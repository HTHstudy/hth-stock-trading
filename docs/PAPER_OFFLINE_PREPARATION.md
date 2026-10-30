# 실제 시세 Paper의 오프라인 계좌 준비

시장 관측 결과를 기다리는 동안 키·토큰·시세 없이 새 가상 계좌를 준비하는 절차다. 기존 `paper:market --initialize`는 이후 broker 관측까지 실행하므로 대기 중 준비와 분리했다. 신규 `paper:prepare`는 broker·source·worker를 생성하지 않는다. 준비 완료는 시장 검증이나 모의 거래 재개 승인이 아니다.

## 책임과 불변조건

- 기본은 계획 미리보기다. 키·DB 없이 동작하고 `.env`를 자동으로 읽지 않는다.
- `--apply`는 새 `paper-market-*` 계좌만 생성한다. 기존 계좌·원장·현금·손실·전략을 수정하지 않는다.
- 계획 hash를 DB 연결/마이그레이션 전에 검증하고 DB 계층에서도 저장할 자금·한도·전략으로 다시 계산한다.
- 계좌·한도·전략 revision 1·불변 변경 이력·계획 hash가 포함된 ACCOUNT_CREATED 감사 기록을 한 트랜잭션에 커밋한다. 일부 저장 실패는 전체 롤백한다. 같은 ID 경합은 하나만 성공한다.
- 초기 계좌는 paper/toss-readonly, stopped=true, version/epoch=0, lease 없음, 보유/의도/예약/체결 없음이다. 실제 잔고를 복사하지 않는다.
- 초기 `observedAt`은 준비 시점의 DB 시각이며 시장 관측 증거가 아니다. `reconciled=false`를 유지하고 초기 일일 기준은 DB 시각의 시장 거래일로 만든다. 다음 거래일이 되면 기존 일일 검토 절차를 따른다.
- `--check`는 repeatable-read/read-only snapshot에서 설정·해시·변경 이력·준비 감사 기록·정지·lease·자금·주문/체결 없음을 함께 검증한다. 조회로 대사·평가·worker 시작·마이그레이션을 실행하지 않는다.
- 결과는 초기 준비 일치 여부다. 기존 계좌가 이후 관측/변경/매매를 거쳤다면 불일치를 표시하며 초기값으로 복구하지 않는다. `canResume=false`, `marketReadiness=not-checked`, `executionEnabled=false`를 유지한다. 계좌 ID·DB URL·키·원본 오류는 CLI 결과에서 제외한다.

## 기본 미리보기

```bash
corepack pnpm paper:prepare --plan=examples/paper-market-kr-validation-v1.json
corepack pnpm paper:prepare --plan=examples/paper-market-us-validation-v1.json
```

검토한 자금·한도·전략·해시는 [검증 설정 v1](PAPER_VALIDATION_SETTINGS.md)을 따른다. `--apply`/`--check`에는 새/대상 계좌 ID와 정확한 `--plan-hash`를 함께 요구한다. `--resume`은 지원하지 않으며 `--apply --check`, `--check --migrate`도 거부한다.

## 개발용 전용 DB

현재 로컬 개발 환경의 업무 DB(5432)·기존 합성 Paper DB(59257)를 보존하기 위해 별도 `infra/compose.paper-market.yml`을 사용한다. 이는 로컬 4서비스 운영 구성에 DB를 하나 더 요구하는 설계가 아니다. 개발 중 실제 시세 Paper 원장을 격리하기 위한 단일 PostgreSQL 컨테이너이며, 향후 4서비스 구성으로 이관할 때는 백업/복원한다.

```bash
corepack pnpm paper:local:config
corepack pnpm paper:local:up
```

첫 명령은 서버 전용 `.local-data/paper-market-local/.env`를 0600, 상위 디렉터리를 0700으로 생성한다. 관리자와 Paper 역할 비밀번호를 별도로 무작위 생성하며 기존 파일을 덮어쓰지 않는다. 키/기존 root env를 복사하지 않는다. 포트는 loopback 55434이고 영속 볼륨은 `hth-paper-market-local_paper_market_data`다. 포트가 이미 사용 중이면 임의로 다른 서비스나 볼륨을 삭제하지 않고 충돌부터 확인한다.

새 볼륨 초기화는 기존 역할 분리 스크립트를 사용한다. 실제 작업 역할은 비관리자 `hth_test`, 대상 DB는 `hth_readonly_test`다. 이 구성의 `hth_trading`은 PostgreSQL 초기화용 빈 DB이며 실제 broker 잠금 DB를 이전한 것이 아니다. 실제 broker 작업은 계속 기존 root 설정의 DATABASE_URL을 사용해야 한다. 기존 비밀번호는 env 수정만으로 변경되지 않는다. 설정 파일을 잃으면 원장을 지워 새로 만드는 대신 비밀 백업을 복구한다.

## 명시적 새 계좌 준비와 점검

아래 ACCOUNT/HASH는 실제 사용할 새 Paper ID와 미리보기 hash로 바꾼다. 기존 계좌는 `--apply`로 다시 실행하지 않는다. 계획을 확인한 뒤 전용 DB에만 명시적으로 마이그레이션한다.

```bash
corepack pnpm build:packages
corepack pnpm --filter @hth/worker build
node --env-file=.local-data/paper-market-local/.env apps/worker/dist/paper-prepare-run.js \
  --apply --migrate --account=ACCOUNT \
  --plan=examples/paper-market-kr-validation-v1.json --plan-hash=HASH

node --env-file=.local-data/paper-market-local/.env apps/worker/dist/paper-prepare-run.js \
  --check --account=ACCOUNT \
  --plan=examples/paper-market-kr-validation-v1.json --plan-hash=HASH
```

미국은 미국 계획과 별도 새 계좌를 사용한다. 최초 스키마 적용 뒤에는 `--migrate`를 생략한다. 기동/조회는 마이그레이션을 자동 적용하지 않는다. 명령 응답이 불확실하면 먼저 같은 ID로 `--check`한다. 기존 계좌 오류를 무시하거나 새 ID로 무조건 재시도하지 않는다. 후속 점검 실패가 이미 커밋된 준비를 취소한다는 의미도 아니다.

로컬 Compose 내부 DB 주소 `db:5432` 허용은 기존 production/LOCAL_CONTAINER_MODE 경계를 유지한다. 기본 개발 검증은 localhost/127.0.0.1 전용 역할/DB만 사용한다. 실제 연결 대상의 DB·역할도 확인한다.

## 백업과 종료

```bash
corepack pnpm paper:local:backup
corepack pnpm paper:local:down
```

백업은 Paper DB만 custom dump/0600 신규 파일에 저장한다. 기존 파일 덮어쓰기를 거부한다. `down`은 볼륨을 보존한다. 계좌 ID·계획 hash를 보관한 로컬 manifest, 점검 리포트와 비밀 env는 원장 dump와 함께 별도 보관하되 Git에 넣지 않는다. 기존 `local:backup`은 여전히 기본 broker 대상이며 새 `--stack=paper-market` 옵션을 명시해야 개발용 Paper DB를 선택한다.

복원은 새 빈 DB에 먼저 수행하고 원본을 덮어쓰지 않는다. [기존 복원 절차](LOCAL_OPERATIONS.md)의 Paper 역할/소유권을 따른다. 현재 예시는 `hth_paper_restore_check`에 복원해 검증한 뒤 해당 확인용 DB만 정리했다. DB 백업은 파일/비밀 설정과의 공동 snapshot이 아니므로 실제 이관 시 쓰기 작업을 멈추고 같은 운영 시점을 보존한다.

## 2026-10-30 준비 기록

새 개발용 DB에서 검증 계획 v1의 국내/미국 계좌를 각각 생성했다. 계좌별 15개 준비 조건이 모두 일치했고 DB 재시작 후에도 정지·lease 없음·주문/예약/체결 없음이 유지됐다. 준비 명령은 실제 broker·시세·계좌 API와 worker를 실행하지 않았다. 원래 업무 DB/합성 DB의 데이터와 웹의 현재 연결 대상은 변경하지 않았다.

기존 root 설정의 broker 잠금 DB 접속과 동일 client advisory lock 획득/해제를 토큰 없이 확인했다. 확인 시 잠금은 비어 있었으며 미래 실행이나 공유 설정의 지속적 일치를 보장하는 결과는 아니다. Paper 원장은 해당 DB와 분리돼 있다. broker 잠금을 새 Paper DB로 옮기지 않는다.

계좌 manifest·준비/재점검 리포트·접속 점검은 `.local-data/paper-market-local/`에만 보관한다. `prepared-accounts.dump`를 새 확인용 DB에 복원해 계좌 2/정지 2/lease 0/전략 2/전략 이력 2/준비 감사 기록 2/주문 0/체결 0을 확인했다. 기존 데이터나 계좌에 덮어쓰지 않았다. 설정 파일/백업의 재생성 거부도 확인한다.

전체 431개 테스트를 단일 worker와 별도 임시 PostgreSQL에서 통과했다. 새 9개 테스트는 미리보기 무접속, hash 불일치의 I/O 이전 차단, live/재개/상충 옵션 거부, KR/US 준비, 읽기 전용 점검, 동시 초기화, 설정 변경 감지, 감사 저장 실패 시 전체 롤백을 검증한다. 타입·린트·빌드·포맷과 새 Compose 구문 검사도 통과했다. 서버/웹 Docker 이미지를 다시 빌드했고 공개 예제 계획을 이미지에 포함했다. 서버 이미지를 network=none/read-only로 실행해 양 시장 미리보기와 동일 planHash를 확인했고 env·키·로컬 데이터·빌드 CA가 포함되지 않은 것도 확인했다. 새 앱 의존성은 추가하지 않았다.

## 아직 실행하지 않은 단계

미국 관측 최종 결과·국내 연속성/세션/수명 증거 검토, 신선한 실제 시세 정지 관측, 필요한 일일 손실 검토, 유한 Paper 명시적 재개가 남았다. 계획/준비 해시는 운용 승인이 아니다. 기존 `paper:market`에서 준비된 계좌에 `--initialize`를 다시 사용하지 않는다. 실제 조회를 시작할 때는 이 Paper DB 설정과 **기존 broker 잠금 DB/키 설정**을 서버에서 함께 사용하고, 관측 소유자 정리 후에만 진행한다. 웹에서 두 계좌를 자동 전환하거나 worker를 시작하지 않는다.
