# Paper 실행 전후 원장 검토

`paper:review`는 기존 Paper 원장을 읽어 checkpoint를 저장하고 두 checkpoint 사이의 변화를 비교한다. broker·시세 source·worker를 만들지 않고 계좌 생성/관측/재개/정지/마이그레이션/주문도 수행하지 않는다. 기본은 DB·키·파일 없이 실행되는 미리보기다. 실제 계좌 주문과 연결되지 않는다.

## 사용 방법

```bash
corepack pnpm paper:review
```

capture는 명시한 기존 계좌 하나의 읽기 전용 repeatable-read snapshot을 가져온다. `--kind=market`은 `paper-market-*`와 `PAPER_MARKET_DATABASE_URL`, `--kind=synthetic`은 `paper-demo-*`와 `PAPER_DEMO_DATABASE_URL`을 사용한다. 기본 kind는 market이다. URL과 실제 접속 DB/role 모두 localhost의 `hth_readonly_test`/`hth_test` 전용 경계를 검사한다. 기존 업무 DB를 지정하지 않는다. `.env`를 자동으로 읽지 않는다. 로컬 production 컨테이너는 기존 명시적 LOCAL_CONTAINER_MODE 경계만 따른다.

로컬 준비 DB 설정을 서버에서 명시적으로 읽는 예시는 다음과 같다. `<ACCOUNT>`는 서버의 준비 manifest에서 확인한 계좌 ID이며 출력 파일/문서에는 그대로 쓰지 않는다. 아래 명령은 해당 계좌에 읽기만 수행한다.

```bash
corepack pnpm build:packages
corepack pnpm --filter @hth/worker build
node --env-file=.local-data/paper-market-local/.env \
  apps/worker/dist/paper-review-run.js --capture --kind=market \
  --account=<ACCOUNT> --output=.local-data/paper-reviews/<REVIEW-ID>/before.json
```

실행 후 별도 명령으로 `after.json`을 캡처하고 비교한다. 이 도구는 그 사이의 실행을 시작하지 않는다. 실제 시세/일일 검토/재개 절차는 기존 운영 규칙을 따르며 checkpoint 보유 자체는 운용 승인이 아니다. 초기 준비 상태를 보관한 checkpoint와 실행 직전 baseline을 구분한다. 일일 기준 검토·설정 변경 전에 캡처한 자료를 변경 없는 실행 baseline으로 재사용하지 않는다.

```bash
corepack pnpm paper:review --compare \
  --before=.local-data/paper-reviews/<REVIEW-ID>/before.json \
  --after=.local-data/paper-reviews/<REVIEW-ID>/after.json \
  --output=.local-data/paper-reviews/<REVIEW-ID>/report.json
```

compare는 DB/키 없이 파일만 읽는다. 입력 누락·변조·비정상 파일도 정상으로 표시하지 않고 미완료 리포트를 기록한다. before/after 옵션을 생략하면 누락된 자료로 취급한다. 출력 파일은 덮어쓰지 않으므로 새로운 경로를 사용한다. CLI 종료 코드는 일치한 관측 구간/미리보기/capture 성공 0, 문제 발견 또는 미완료 리포트 기록 2, 설정·DB·출력 실패 1이다. 콘솔에는 상태/내용 hash/판정만 출력하며 계좌·원장·DB URL·원본 오류를 출력하지 않는다.

## 검사와 판정

- snapshot과 report는 strict 계약과 canonical JSON SHA-256을 사용한다. 계좌/출처/DB host·port·name·role의 scope가 같고 시각/version/epoch가 역행하지 않아야 한다. 비밀번호는 scope에 포함하지 않는다.
- 의도와 체결의 요청 hash, 영구 중복 키, 체결 합계/수량/금액/비용, 고유 키, 소유권·원가 수량을 검사한다. 기존 의도 식별/요청과 과거 체결·이벤트의 보존 여부를 확인한다.
- 새 체결로 현금·보유량·전략 소유량을 재계산하며 수동 보유분은 별도로 보존한다. 수동 소수점 보유량도 지원한다. KRW/USD는 합산하거나 환산하지 않는다.
- 매수 원가는 대금+비용, 매도 원가는 비례 해제 후 통화 최소단위 내림·마지막 잔량 전액 해제를 적용한다. 실현 손익은 대금−비용−해제 원가와 대조한다. 같은 원가 묶음의 체결 시각이 마이크로초까지 같으면 UUID로 체결 순서를 추정하지 않는다.
- 종료 상태는 정지·lease 기록 없음·진행 의도 없음·활성 예약 없음을 요구한다. 부분 체결 후 잔량 정리와 이미 체결된 자산/원가 보존을 구분한다. 부족한 정리를 조회에서 실행하지 않는다.
- lease 획득/해제 각각 1회와 새 관측, 새 의도, 새 체결, 진단 기록 존재를 구분해서 검사한다. 주문 의도를 전략 신호로 추정하지 않으며 진단 내용 자체를 재평가하지 않는다. 진단 기록이 없으면 미검증으로 남긴다. 횟수는 연속 실행·프로세스 생존의 증명이 아니다. 복수 lease 구간, 외부 대사/일일 검토/알 수 없는 이벤트, baseline 이전 시각으로 작성됐지만 뒤 snapshot에 나타난 기록은 미확인으로 남긴다.

`consistent-observed-state`는 이 제한된 구간에서 제공한 검사들이 일치했다는 의미다. 하나라도 불일치하면 `issues-found`, 자료나 실행 경로·순서 증거가 부족하면 `incomplete`다. 신호/체결이 없는 구간은 원장이 같아도 실행 경로 검증 완료로 표시하지 않는다. 모든 판정에서 `executionEnabled=false`, `canResume=false`를 유지한다.

리포트는 통화별 현금 전후, 비용, 실현 손익, 전략별 원가 전후, 일일 손익의 저장값 전후와 검사 결과를 제공한다. 일일 손익과 평가자산은 quote/mark를 수집하지 않아 재검증하지 않는다. 일일 손익은 미실현 평가 변화를 포함하므로 실현 손익 합계와 일치해야 한다고 가정하지 않는다. 수동 자산을 포함한 자산 변동을 전략 수익률로 표시하지 않는다. 수익성, 데이터 신선도, 실제 시장 준비도, 특정 worker 실행과의 완전한 연계는 보장하지 않는다. 전략 설정 안정성은 저장된 version/revision/definitionHash 메타데이터 비교이며 전략 입력의 재평가가 아니다.

## 보관과 조회 제한

계좌 ID·전략 ID·주문/체결 ID는 내용 hash로 치환하고 lease token·원본 요청/decision/감사 details·인증 정보를 제거한다. hash는 익명화나 작성자 공증/서명이 아니며 다시 계산한 조작 자료까지 인증하지 않는다. 신뢰된 서버에서 캡처한 private 파일로 관리한다. 계좌 ID가 없는 파일도 가상 현금·보유 종목·거래 금액을 포함하므로 외부 공개하지 않는다. 웹/API는 이번 작업 범위에 추가하지 않는다.

capture는 table별 최대 5,000개, 보유 종목 최대 1,000개를 허용하며 초과하면 실패한다. 최근 기록만 잘라 완전한 증거로 내보내지 않는다. statement timeout은 3초다. 장기 계좌의 분할·보존 정책은 후속이다. 입력은 일반 파일·32MiB 이하·최종 경로 symlink 금지이며 새 출력도 32MiB 이하로 제한한다. 새 디렉터리는 0700, 파일은 0600이며 임시 파일 sync 후 hard link로 원자적으로 생성하고 기존 파일을 덮어쓰지 않는다. 이미 존재하는 상위 디렉터리 권한은 변경하지 않는다.

## 검증 범위

단위 테스트는 부분 체결/비용/수동 소유권, 매도 원가 내림·실현 손익, USD 센트, 중복/누적 불일치, 미정리 상태, 변조/누락, 동률·마이크로초 역행·늦은 커밋, 외부 변경을 검증한다. 파일/CLI 테스트는 무접속 미리보기·live/잘못된 옵션/DB 거부·오프라인 비교·hash·권한·덮어쓰기/symlink/크기 제한·종료 코드를 확인한다.

DB 테스트는 새 임시 전용 DB에만 합성 계좌/시세를 만든다. KR/US에서 기존 worker로 부분 체결 후 잔량 정리→capture→비교를 연결하고, 조회 시각을 제외한 전후 원장 보존·비공개 필드 제거·이력 초과 거부를 검증한다. 실제 준비 계좌를 재개하거나 실제 시세/증권사 API를 호출하지 않는다. 기존 준비 계좌에서 만든 초기 checkpoint는 정지 상태 기준 보관이며 실제 실행/체결 경로 통과 자료가 아니다. 새 의존성이나 DB 마이그레이션은 추가하지 않는다.

2026-11-02 최종 보강본을 별도 소스 복사본의 Linux Node 24/PostgreSQL 17에서 검증했다. 기본 병렬 설정으로 79개 파일·477개 테스트와 format/lint/typecheck/build가 모두 통과했다. 두 Compose config 검사도 통과했다. 소스 복사본에는 키·환경파일·로컬 운영 데이터를 포함하지 않았다.

기존 로컬 준비 DB의 KR/US 두 계좌에서 초기 checkpoint만 읽기 전용으로 보관했다. `.local-data/paper-reviews/0843cd1b-3425-43f7-a62a-bb1067532ca6/`의 `kr-before.json`, `us-before.json`과 실행 후 자료 누락을 나타내는 두 `*-missing-after.json`이다. 디렉터리 0700/파일 0600과 Git 제외를 확인했고, 준비 조건 일치·정지·lease/의도/체결 없음 및 조회 전후 원장/설정/이력 hash 보존을 확인했다. 두 비교 판정은 `incomplete`이며 실제 실행 또는 체결 검증 통과가 아니다. 일일 기준 검토나 실제 시세 관측/재개는 수행하지 않았다.
