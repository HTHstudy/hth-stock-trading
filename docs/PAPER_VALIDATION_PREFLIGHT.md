# Paper 고정 입력과 실행 전 점검

## 11월 3일 미국 중단 원인

미국 실행 `3bbd7ebb-cd47-43df-b2a9-37abffffc81c`은 2026-11-03 23:35 KST에 account-preflight에서 중단됐다. runStarted=false·completedTicks=0이고 failure-after에서 정지·lease/예약 정리를 확인했다. 일일 검토·정지 관측·60 tick 재개 단계는 시작하지 않았다.

개발 중 기존 실행을 고정 빌드로 분리할 때 컴파일 JS·의존성은 복사했지만 `examples/paper-market-us-validation-v1.json`을 빠뜨렸다. `readPaperMarketPlan`은 자기 모듈의 import.meta.url 기준으로 root를 정하므로, 고정 빌드에서는 원래 저장소가 아닌 복사본의 examples를 찾았다. 그 파일이 없어 PAPER_MARKET_PLAN_INVALID가 발생했다. 당시 허용 오류 목록에 이 코드가 없어 결과는 PAPER_VALIDATION_NOT_COMPLETED로 축약됐다. 계좌·증권사 인증이나 시세 오류가 원인은 아니었다.

DB를 여는 factory를 막은 상태로 같은 고정 모듈·상대 경로 호출을 재현해 PAPER_MARKET_PLAN_INVALID와 databaseOpened=false를 확인했다. 원래 계획 파일은 서버 준비 manifest의 planHash와 일치했다. 과거 실행 파일/고정 빌드/실패 기록을 수정하지 않았다.

## 수정한 경계

코드와 실행 입력을 각각 고정한다. `paper-validation-resources`는 승인된 계획 hash·시장·strict schema를 검증한 뒤 새 UUID 폴더에 plan.json과 manifest.json을 만든다. 계획을 최신 시세나 다른 설정으로 대체하지 않는다. 이전 폴더를 덮어쓰지 않으며 키/계좌/토큰/환경파일은 복사하지 않는다.

manifest에는 formatVersion/market/planHash와 내용 hash만 들어간다. 검증 후 반환한 **절대 planPath**를 기존 preparation의 --check에 전달한다. 모듈을 다른 곳으로 옮겨도 원래 저장소나 암묵적인 examples root를 추정하지 않는다. 자료가 빠졌거나 바뀌면 DB 점검 전에 차단한다.

파일은 plan 최대 64KiB·manifest 최대 16KiB, 일반 파일/O_NOFOLLOW·strict schema·hash·시장·고정 이름으로 검사한다. 디렉터리 symlink와 검증 전후 경로 변경을 거부한다. 새 디렉터리는 0700, 파일은 0600·원자적 새 생성이다. 신뢰된 서버 소유자의 private 파일 경계이며 악의적인 동일 UID 부모 경로 교체 경쟁의 완전 차단이나 작성자 서명은 아니다.

## 사전 점검 CLI

```bash
# 키/DB/파일 접근 없는 기본 미리보기
corepack pnpm paper:validation:preflight
```

pin과 check는 별도다. plan-hash는 기존 서버 승인 manifest의 값을 사용한다. 계좌와 경로를 브라우저에서 받지 않는다. 경로는 모두 서버에서 명시한 절대 경로이며 자동 빌드/마이그레이션은 없다.

```bash
node apps/worker/dist/paper-validation-preflight-run.js --pin --market=US \
  --plan="$PWD/examples/paper-market-us-validation-v1.json" \
  --plan-hash=<APPROVED-PLAN-HASH> \
  --output-root="$PWD/.local-data/paper-validation-resources"

# pin 결과의 새 UUID/해시를 확인한 뒤 별도로 수행하는 읽기 전용 DB 검사
node --env-file=.local-data/paper-market-local/.env \
  apps/worker/dist/paper-validation-preflight-run.js --check --market=US \
  --resources="$PWD/.local-data/paper-validation-resources/<RESOURCE-UUID>" \
  --resources-hash=<RESOURCE-HASH> --account=<SERVER-ACCOUNT>
```

출력에는 상태·hash/UUID·허용된 점검 boolean만 넣고 계좌·경로·계좌 응답은 넣지 않는다. check는 전용 테스트 DB의 기존 준비 조회만 사용한다. create/migrate/resume/stop·broker·시세·주문을 실행하지 않는다. initialControl/unreconciled 같은 최초 초기화 조건은 이전 관측 이후 false일 수 있으므로 false를 계좌 재초기화 사유로 삼지 않는다. 현재 제어 version/epoch·날짜·리스크·시장 준비는 이후 단계에서 따로 확인한다. marketReadiness=not-checked, executionEnabled/canResume=false를 유지한다.

## 대기 전 실행기 검증

기존 private 스크립트에서 사용한 일회성 흐름을 `infra/authorized-paper-validation.mjs`로 편입했다. 기존 제어 CAS·손실 이월·별도 정지 관측·최대 60 tick·전후 checkpoint/대사·자동 재시도 금지를 유지한다.

```bash
# 기본은 실행 없는 미리보기
node infra/authorized-paper-validation.mjs --market=US

# 고정 입력만 확인. 환경파일·DB·계좌·대기·Paper 실행 없음
node infra/authorized-paper-validation.mjs --market=US --verify-inputs \
  --build-root="$PWD" \
  --resources="$PWD/.local-data/paper-validation-resources/<RESOURCE-UUID>" \
  --resources-hash=<RESOURCE-HASH>
```

실제 대기에 들어가려면 별도 --run/--resume-authorized 둘 다와 새 prerequisite/start-at/deadline, 코드/lockfile/실행기 hash, 기대 계좌 제어 파일/hash, resource 경로/hash가 필요하다. 코드·계획·제어 기준 파일과 시각을 **대기 이전**에 검사한다. 대기 전에는 키/DB를 열지 않는다. start-at은 최대 36시간 뒤, deadline은 해당 시작(국내 즉시 실행은 현재)에서 최대 30분으로 제한한다. 기한 경과·시작 누락·알 수 없는/중복 인자는 거부한다. 이전 11월 3일 일정을 기본값으로 재사용하지 않는다.

대기 후 DB 점검 전과 재개 직전에도 입력 hash를 재확인한다. 코드 fingerprint에는 현재 실행기 자체도 포함한다. resourcesHash는 별도 request 필드에 묶고 공개 조회 DTO에는 노출하지 않는다. 준비가 통과해도 시장 품질·손실 검토·현재 제어 상태를 확인하지 않은 채 실행하지 않는다. 별도 명시적 Paper 실행 의사가 없는 조회/미리보기는 재개하지 않는다.

계획 파일 누락·해시 불일치·고정 입력 묶음 오류는 공통 허용 코드와 화면 레이블로 구분한다. 알 수 없는 예외 원문/경로/계좌는 계속 일반 코드로 제거한다. 기존 실패 결과의 일반 코드는 사후 교체하지 않는다.

## 실제 수정 검증과 남은 범위

조사 결과는 private `.local-data/paper-validation-investigations/127b9d18-612e-4364-b030-d3c44ece95e2/result.json`에 보관했다. 새 고정 입력 `4a2deff1-86e1-44a8-a5b9-3afde02ff79e`를 **실패 당시 고정 코드**에 절대 경로로 전달한 읽기 전용 preparation은 checked로 완료됐고, 당시 실행기가 요구한 준비 조건들은 모두 true였다. KR/US Paper 두 계좌의 전후 checkpoint는 조회 시각을 제외하고 같은 hash였다.

이 검증은 --check뿐이다. 실제 시세·토큰 발급·일일 기준 적용·Paper 재개·새 예약은 수행하지 않았다. 새 일정의 미국 60 tick 실행·주문/체결 경로는 여전히 미검증이다. 기존 실패 기록과 고정 빌드도 그대로 보존한다.

단위 검사는 계획 없는 이동 빌드 재현, 절대 경로 해결, 원본 파일 변경 후 고정 입력 보존, 누락/시장/hash/symlink 거부, DB 전 차단·live 거부·미리보기, 실행기의 무접속 입력 검증·만료 일정/잘못된 옵션 차단과 오류 표시를 확인한다. 테스트 코드에서는 실제 broker를 호출하지 않는다.

기본 전체 검사는 470개 통과·DB 통합 102개 제외다. 타입·린트·빌드·포맷도 확인했다. CLI 자식 프로세스의 시작 비용을 포함해 해당 테스트는 20초 한도로 검사한다. 전체 worker 수는 CPU 수에 따라 최대 4개이며, 여러 실제 임시 커밋을 순서대로 만드는 기존 Git 훅 통합 검사는 60초 한도로 조정했다. 실제 pre-commit/pre-push 검사 항목과 실행기·시세 timeout을 완화한 것은 아니다.
