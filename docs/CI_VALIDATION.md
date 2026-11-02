# Git 자동 검증과 CI

## 자동 Git hook

`pnpm install`의 `prepare`에서 Husky를 설치한다. 기존 checkout은 `corepack pnpm run prepare`로 연결할 수 있다. 실제 검사 명령을 `.husky/`에 버전 관리한다.

| 시점               | 자동 검사                                            | 실패 시   |
| ------------------ | ---------------------------------------------------- | --------- |
| pre-commit         | 스테이징 파일 ESLint·Prettier                        | 커밋 차단 |
| pre-push 기본      | 전체 타입 검사·DB 없는 단위 테스트                   | 푸시 차단 |
| pre-push 관련 변경 | 기본 검사 후 새 임시 DB에서 통합 테스트 추가         | 푸시 차단 |
| GitHub Actions     | 포맷·린트·타입·전체 DB 통합 테스트·전체 빌드·Compose | CI 실패   |

pre-commit은 자동 수정 없이 lint-staged의 백업/부분 스테이징 처리를 사용한다. pre-push는 타입 검사 과정에서 패키지/worker를 한 번 빌드한 후 Vitest를 직접 실행해 테스트용 중복 빌드를 줄인다. 전체 포맷·린트·배포 빌드·Compose 검사는 매 푸시에 반복하지 않고 CI에서 유지한다. GitHub workflow와 verify:ci의 전체 검사 범위는 변경하지 않는다.

단위 테스트는 `*.integration.test.ts`를 제외한다. DB 통합 테스트는 반드시 이 파일명 규칙을 사용하고 CI에서 전부 실행한다. 독립 실행은 `corepack pnpm test:unit`을 사용한다. 단위 검사에는 상속된 TEST_DATABASE_URL을 전달하지 않는다.

원격 대상 SHA부터 푸시할 HEAD까지의 모든 커밋을 비교한다. 삭제/이름 변경도 빠뜨리지 않도록 NUL 구분과 rename 미적용 diff를 사용한다. DB/트레이딩/공통 계약 패키지, API·worker의 paper-* 파일, 푸시 검사 코드, 루트 의존성/lockfile/workspace/TS 설정 변경이면 DB 통합 검사를 추가한다. 새 브랜치나 로컬에서 원격 기준 SHA를 확인하지 못한 경우도 보수적으로 DB 검사를 실행한다. 문서·일반 웹 소스만 바뀌면 Docker를 사용하지 않는다.

DB 검사가 필요하면 Docker에서 매번 새 PostgreSQL 17 테스트 DB를 생성한다. localhost 임의 포트·고유 이름을 사용하며 기존 업무/Paper DB 주소·볼륨을 재사용하지 않는다. 상속된 TEST_DATABASE_URL도 새 주소로 대체한다. Docker는 이 분기에서만 필요하고 직접 DB URL을 준비할 필요는 없다.

```bash
git push
```

DB 준비는 최대 30초 확인하고 성공/실패/SIGINT/SIGTERM 이후 이번 컨테이너만 정리한다. DB 생성·준비·정리 실패도 푸시를 차단한다. 강제 종료(SIGKILL)/호스트 장애 시 남은 hth-push-test-* 컨테이너는 별도로 확인한다. GUI에서는 Node/Corepack을, DB 검사가 필요한 변경에는 Docker도 실행할 수 있어야 한다. hook을 우회하지 않는다.

푸시 대상은 현재 HEAD이고 작업 디렉터리는 깨끗해야 한다. 작업 중인 수정이 커밋의 오류를 가리는 것을 막는다. 다른 브랜치의 커밋을 푸시하려면 해당 커밋을 checkout한 별도 worktree에서 설치/검증한다. 다른 작업을 강제로 stash하거나 함께 커밋하지 않는다. 브랜치 삭제와 업데이트 없는 푸시는 검사할 코드가 없으므로 전체 검사를 생략한다.

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

## 푸시 환경 개선

기존 hook은 사용자가 임시 DB와 TEST_DATABASE_URL을 매번 준비해야 했다. 검증용 DB 종료 후 일반 셸/GUI에서 푸시하면 전체 검사를 시작하지 못하는 문제를 해결하기 위해 pre-push의 DB 생성/대기/정리를 자동화했다. 기존 DB 설정 무시·localhost 포트 검사·실패 전파·SIGTERM 정리·삭제/no-op 생략을 가짜 도구 테스트로 검증한다. CI는 기존 PostgreSQL service와 직접 verify:ci를 유지하며 테스트에서 실제 broker를 호출하지 않는다. 새 라이브러리는 추가하지 않았다.

## 로컬 검사 범위 조정

전체 검사 자체는 CI에 유지하고 로컬 기본 경로는 타입·단위 테스트로 줄였다. 관련 파일 변경 시에는 DB 통합 검증을 자동 추가한다. 단위·통합 선택과 실패 전파, 새 브랜치/원격 기준 미확인의 보수적인 처리, 임시 DB 생성/정리와 중단 정리를 테스트한다. 로컬 단위 검사 통과를 전체 CI 통과로 보고하지 않는다. 새 의존성은 추가하지 않았다.
