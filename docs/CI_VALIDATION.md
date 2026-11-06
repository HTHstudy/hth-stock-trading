# Git 자동 검증과 CI

## 자동 Git hook

`pnpm install`의 `prepare`에서 Husky를 설치한다. 기존 checkout은 `corepack pnpm run prepare`로 연결할 수 있다. 실제 검사 명령을 `.husky/`에 버전 관리한다.

| 시점           | 검사                                                 | 실패 시                        |
| -------------- | ---------------------------------------------------- | ------------------------------ |
| pre-commit     | 스테이징 파일 포맷·린트·관련 단위 테스트             | 커밋 차단                      |
| pre-push       | 별도 검사 없음                                       | Git 자체 전송/권한 검사만 수행 |
| GitHub Actions | 포맷·린트·타입·전체 테스트/DB 통합·전체 빌드·Compose | CI 실패                        |

pre-commit은 lint-staged의 기본 백업/부분 스테이징 처리를 사용한다. Prettier와 ESLint는 자동 수정하지 않는다. 코드 변경에는 `infra/test-related.mjs`가 Vitest related --run으로 의존 관계에 있는 단위 테스트를 실행한다. 변경 테스트 파일 자체와 같은 이름의 단위 테스트도 대상으로 포함한다. DB 통합 테스트는 *.integration.test.ts로 구분해 로컬 관련 검사에서는 제외하고 CI에서 실행한다. 관련 단위 테스트가 없으면 그 사실을 Vitest 출력으로 표시하고 통과시키며 전체 검증 통과로 표현하지 않는다.

apps/packages 코드나 Vitest 설정 변경 시에는 테스트가 참조하는 공통 패키지와 worker 산출물을 먼저 빌드한다. 전체 웹 프로덕션 빌드나 전체 타입 검사를 수행하는 것은 아니다. 패키지 소스와 대응하는 dist 모듈·공개 entrypoint를 함께 관련 대상으로 넘겨 public export 경유 의존성을 추적한다. infra 코드만 변경하면 이 준비 빌드를 생략한다. 관련 검사에는 TEST_DATABASE_URL을 전달하지 않으며 Docker를 시작하지 않는다. 동적 import·삭제/rename 등 모든 영향 범위를 완벽하게 증명하는 검사나 CI 대체가 아니므로 CI 전체 검증을 유지한다.

`.husky/pre-push`와 이전 선택적 검사/임시 DB 생성 코드는 제거했다. 이미 설치된 Husky 내부 pre-push wrapper가 남아도 실행할 hook 파일이 없어 바로 종료한다. `git push`는 로컬 테스트를 기다리지 않고 전송한다. 깨끗한 작업 디렉터리나 현재 HEAD만 푸시해야 한다는 별도 hook 제약도 제거했다. 직접 단위 테스트 전체를 실행하려면 `corepack pnpm test:unit`을 사용한다.

CI와 Docker 빌드는 `HUSKY=0`으로 Git hook 설치를 생략하고 전체 CI 검사는 그대로 실행한다. Docker는 package manifest만 먼저 복사하므로 `prepare: husky`가 `.husky` 파일을 요구하지 않도록 이 환경 설정을 설치 전에 둔다.

Husky는 Git hook 공유/설치, lint-staged는 부분 스테이징·공백 포함 경로·실패 복원 처리를 위해 개발 의존성으로만 추가했다. 직접 hooksPath와 쉘 파일 목록을 관리하는 대안보다 별도 Git 처리 코드를 줄인다. [Husky 공식 설정](https://typicode.github.io/husky/get-started.html)과 [lint-staged 공식 설명](https://github.com/lint-staged/lint-staged)을 따른다. 로컬 hook은 우회/비활성화가 가능하므로 CI도 유지한다. 원격 병합을 강제 차단하려면 저장소의 required status check 설정이 별도로 필요하다. 이번 작업에서 원격 보호 규칙은 변경하지 않는다.

## 전체 검증 명령

Node 24와 lockfile의 pnpm을 사용한다. 직접 `verify:ci`를 실행할 때는 전용 PostgreSQL의 `TEST_DATABASE_URL`을 설정한 뒤 아래 명령을 실행한다. 직접 실행은 DB를 자동 생성하지 않는다. URL은 localhost/127.0.0.1, DB `hth_readonly_test`, role `hth_test`만 허용한다. 업무 DB나 기존 Paper 운영 DB를 지정하지 않는다.

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm verify:ci
docker compose -f infra/docker-compose.yml config --quiet
docker compose -f infra/compose.local.yml config --quiet
```

`verify:ci`는 format → lint → typecheck → test → build를 순서대로 실행하며 하나라도 실패하면 중단한다. GitHub Actions도 같은 명령을 사용한다. 테스트 DB가 없거나 임의 옵션/`VITEST_MAX_WORKERS`가 지정되면 시작 전에 거부한다. DB가 없어서 통합 테스트를 건너뛴 결과나 `--maxWorkers=1`을 사용한 진단 결과를 전체 CI 검증 완료로 보고하지 않는다. 개별 테스트 실행은 원인 분석에 사용할 수 있지만 마지막 검증은 기본 병렬 실행으로 수행한다. 이 명령은 커밋이나 푸시를 자동 수행하지 않는다.

## 2026-11-02 간헐 실패 원인

[Actions 실행 41370232632](https://github.com/HTHstudy/hth-stock-trading/actions/runs/41370232632)는 442개 중 Paper 통합 리허설 한 개가 실패했다. `US/buy-reserved` 검사까지 도달했지만 매수 예약이 없었다. format/lint/typecheck 실패나 테스트 timeout은 아니었다.

UTC `2026-11-02T01:02:35Z`의 합성 입력을 재현하면 세션 끝을 `19:59:59.999`로 생성하던 로직이 정확히 `20:00:00`에 끝나는 봉을 제외했다. 이동평균 교차에 필요한 종료 봉 세 개 중 두 개만 전달되어 warmup 상태가 됐다. 실행 시각에 따라 드러나는 테스트 데이터 결함이다. 이전 로컬 442개 통과는 단일 worker 실행이었으며 이 경계 시각도 검증하지 않았다. 검증을 수행했지만 CI와 같은 조건 및 시각 경계의 검증이 부족했다.

합성 세션 끝을 정확한 배타 경계로 수정하고 기존 봉 종료 정책을 통과하는 후보를 선택한다. 실제 시장 데이터 정책은 완화하지 않는다. 같은 봉 중복 방지 검사는 계좌별 고정 봉 시각을 사용하며 quote/관측 시각만 갱신한다. 실패 시각, KR 자정, 미국 DST 전후 거래일 경계와 분 변경을 회귀 테스트에 포함한다. 통합 검사의 실패 메시지에는 시장/검사명을 포함하며 계좌 ID나 원본 응답은 출력하지 않는다.

수정 검증은 실패 커밋에 해당 수정만 적용한 별도 worktree와 Linux Node 24/PostgreSQL 17 컨테이너에서 수행한다. 기존 관측과 업무 DB는 사용하지 않는다. 로컬 Linux 검증은 새 커밋의 원격 Actions 통과를 대신하지 않으므로 결과를 구분해 보고한다.

최종 수정본은 4CPU Linux Node 24/PostgreSQL 17 환경에서 `verify:ci`를 통과했다. 기본 worker 설정(3 workers)으로 73개 파일·448개 테스트가 모두 통과했고 format/lint/typecheck/build도 성공했다. 두 Compose config 검사도 통과했다. 이 검증 시점에는 진행 중이던 Paper 리뷰 작업을 분리했고 원격 Actions 재실행·커밋·푸시는 수행하지 않았다.

Husky 추가 후 Linux 전체 검증은 75개 파일·453개 테스트와 format/lint/typecheck/build를 통과했다. 실제 임시 Git 저장소에서 오류 커밋 차단과 부분 스테이징 보존을 검증했고, pre-push의 HEAD/작업 파일 검사·실패 전파·삭제/no-op 처리도 검증했다. 테스트용 Git 저장소는 hook에서 상속되는 저장소 환경변수를 제거하고 독립적으로 생성한다.

## 이전 CI 실패와 현재 정책

2026-11-02의 간헐 실패는 실행 시각에 따른 합성 세션 경계 결함으로 재현·수정했다. 로컬에서 동일 검사를 한 번 더 실행하는 방식만으로는 다른 시각의 결함을 보장해 잡을 수 없다. 해당 경계 회귀 테스트를 유지하고 로컬의 관련 검사와 CI 전체 검증을 구분한다. 기존 pre-push의 전체/선택적 검사는 현재 폐기했다. 새 의존성은 추가하지 않았다.

## macOS 로컬 검증 중 절전

2026-11-06 로컬 전체 검사 도중 10:08:43 Idle Sleep, 10:24:19 DarkWake, 10:25:37 Maintenance Sleep, 10:34:20 Wake가 전원 로그에 기록됐다. 해당 실행은 약 973초가 걸렸고 DB/CLI timeout 및 합성 시세 신선도 오류가 함께 발생했다. 실패를 전체 검사 통과로 표시하지 않는다. 이 사실을 과거 GitHub Linux CI 실패 원인으로 일반화하지 않는다.

로컬 전체 검증은 새 전용 임시 DB에서 재실행하고, macOS에서는 아래처럼 **명령 수명 동안만** 자동 유휴 절전을 막을 수 있다. 기존 시스템 절전 설정을 영구 변경하거나 앱/운영 worker에 적용하지 않는다.

```bash
# TEST_DATABASE_URL은 앞 절차의 전용 임시 localhost 테스트 DB만 지정한다.
/usr/bin/caffeinate -i corepack pnpm verify:ci
```

직접 절전·덮개 닫기·강제 종료·전원 장애까지 보장하는 기능은 아니다. GitHub Linux CI는 기존 verify:ci 명령을 유지한다. 테스트 timeout·데이터 신선도·거래 정지 검사를 늘리거나 우회하지 않는다. 테스트 환경이 중단됐다면 전용 일회용 DB만 새로 만들고 기존 운용/개발 DB를 초기화하지 않는다.

같은 변경을 새 일회용 DB와 위 명령으로 다시 검사해 110파일·840개 테스트를 43.19초에 통과했고, 포맷·린트·타입·빌드도 성공했다. 이는 이번 로컬 재실행의 결과이며 원격 Actions 실행 결과는 아니다.
