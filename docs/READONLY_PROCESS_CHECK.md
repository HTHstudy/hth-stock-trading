# 읽기 전용 프로세스 종료·재기동 검증

`readonly:process:check`는 자신이 만든 첫 관측 자식 프로세스를 정상 취소하고 종료를 확인한 다음, 다른 자식 프로세스의 1회 관측을 검증하는 유한 CLI다. 자동 복구 서비스·상시 재시작·관측 재예약·Paper 재개가 아니다. 외부 PID·실행 파일·출력 경로·계좌를 CLI나 HTTP 입력으로 받지 않는다. 새 의존성·스키마·마이그레이션은 없다.

## 실행 경계

```bash
# 기본 미리보기. 키/DB/파일/빌드 접근·자식 프로세스 없음
corepack pnpm readonly:process:check

# 기존 빌드가 준비된 경우 합성 데이터로 실제 OS 프로세스만 검증
corepack pnpm readonly:process:check --execute

# 명시적 실제 읽기 전용 프로필. 종목 한 개를 반드시 지정
corepack pnpm readonly:process:check --execute --kind=market --symbol=KR:005930
```

명령은 빌드를 자동 실행하지 않는다. 미리보기 이후의 실행에는 기존 packages/worker 산출물이 필요하다. 기본 kind는 demo이며 이 프로필은 `.env`·키·DB를 읽지 않는다. market 자식만 기존 root `.env`를 명시적으로 읽는다. 부모는 owner/Paper 설정·키·NODE_OPTIONS를 자식 환경으로 복사하지 않는다. 실제 프로필은 기존 CLI의 동일 client·DB advisory lock과 공유 broker를 사용하고 잠금 경합을 우회하거나 재시도하지 않는다. `--regular-only` 관측이나 정규장 승인으로 바꾸지 않는다.

각 실행은 `.local-data/readonly-process-checks/<UUID>/`의 새 private 디렉터리를 사용하고 first/second 하위에 독립 관측 UUID가 생성된다. 경로/PID/원본 로그/키/계좌를 결과 JSON에 넣지 않는다. 자식 stdout/stderr는 수집하지 않고 기존 strict 파일만 읽는다.

## 검증 순서와 실패

1. 기존 worker/packages의 컴파일 JS와 lockfile hash를 고정한다. 단순 PID가 아니라 직접 spawn한 ChildProcess 핸들만 제어한다.
2. 첫 자식은 2회 요청·완료 후 60초 간격으로 시작한다. 최대 30초 안에 newline으로 완성된 첫 관측을 확인한다. 미확정 부분 줄을 정상 기록으로 파싱하지 않는다.
3. 소유 자식에 SIGTERM을 보내고 정상 종료를 최대 15초 기다린다. 필요하면 그 자식에만 SIGKILL을 보내고 최대 5초 기다린다. 강제 종료·정리 미확인은 실패이며 두 번째 자식을 시작하지 않는다.
4. 정상 exit code와 신호 종료 없음, cancelled summary, 관측 정확히 1회/수집 오류 0, manifest/UUID/source/종목·journal hash·샘플 순서/종목 집합·요약 재집계를 검사한다. 단순 종료나 마지막 로그만으로 통과하지 않는다.
5. 취소/빌드 변경이 없으면 다른 PID의 자식을 1회 요청으로 시작한다. 최대 30초 내 정상 종료 후 같은 검증으로 completed/1회를 확인하고 빌드 hash를 재확인한다. 실패 시 자동 재시도하지 않는다.
6. 실제 프로필에서는 두 자식 각각 토큰 계측 파일의 manifest/hash 연결·clock/limited/inFlight와 initial 성공 1회도 확인한다. 두 프로세스의 initial은 expiry 갱신이 아니다.

부모 SIGINT/SIGTERM도 현재 소유 자식을 정리하고 후속 시작을 막는다. 종료 기한은 실행 중 타이머의 한도이며 OS/PC 중단·SIGKILL·전원 장애 이후 완료 파일이나 실시간 보장을 만들지 않는다. 기한 경과 후 강제 정리가 필요했다면 데이터가 일부 남아도 정상 검증으로 표시하지 않는다. 빌드 검사는 신뢰된 로컬 파일의 변경 검사로, 의존성/실행 환경 전체의 암호학적 인증이 아니다.

파일은 고정 이름·일반 파일·O_NOFOLLOW·크기 상한으로 읽고, UUID 디렉터리/symlink/경로를 확인한다. manifest 8KiB, journal 64KiB, terminal 256KiB, 토큰 계측 128KiB를 넘으면 실패한다. 기존 서버 소유자 전용 private 파일 경계이며 악의적인 동일 UID의 부모 경로 교체 경쟁까지 원자적으로 차단하는 파일 서버는 아니다.

## 결과 해석

`result.json`은 0600 원자적 새 생성이며 결과 body의 내용 hash를 함께 보관한다. 상태·허용 코드·단계·강제 종료 여부·검증된 관측 ID/hash/집계만 남긴다. verified는 **프로세스 수명과 해당 파일 연결**의 제한된 검증이다. 데이터 healthy/closed/blocked는 별도로 보존하며 1회씩의 관측을 장시간 연속 관측으로 합산하지 않는다.

검증기 자체는 Paper 원장을 읽지 않으므로 `paperLedgerCompared=false`다. 원장 비교는 별도 읽기 전용 checkpoint로 수행해야 한다. `tokenExpiryVerified=false`, executionEnabled/canResume=false를 유지한다. 정규장 품질·토큰 만료 갱신·Paper 체결·수익성·자동 복구·실거래 전환을 승인하지 않는다.

관측 요약 재집계는 기존 API의 로직을 worker 공개 helper로 공유했다. HTTP 파일 경계·인증·노출 DTO와 기존 조회 판정은 변경하지 않는다.

## 2026-11-03 실제 확인

실행 `686149dc-58b9-4267-8950-01e46891720e`에서 KR:005930 읽기 전용 프로필을 수행했다. 첫 자식 `8c93c7d8-816f-466a-a11a-f6a7f47c9064`는 1회 관측 후 SIGTERM에 cancelled/exit 0으로 정상 종료했고, 다른 자식 `f3d0875d-df7a-4be9-8759-3faac0cd33f1`은 새 연결로 1회 completed/exit 0을 기록했다. 강제 종료는 없었다. 당시 둘 다 closed 1·healthy 0·blocked 0인 국내 정규장 밖 관측이므로 정규장 수집 검증으로 쓰지 않는다.

각 토큰 계측은 initial started/succeeded 1, expiry/unauthorized/failed/cancelled 0, inFlight 0·limited false·clockUnverified false였다. 그 응답의 expiresInSeconds는 두 경우 모두 86399였으며 미래 실행의 TTL 고정값으로 사용하지 않는다. 이는 짧은 새 연결 2회의 증거로 자연 만료 갱신 검증이 아니다.

별도 서버 스크립트에서 준비 KR/US Paper 두 계좌의 checkpoint를 전후 비교했다. 조회 시각을 제외한 내용 hash가 같았고 계좌·설정·자산·원장 변경이 없었다. private `paper-preservation.json`에 해시와 unchanged=true만 기록했으며 원본 계좌 응답은 저장/출력하지 않았다. 검증기의 기본 paperLedgerCompared=false를 소급 변경하지 않는다. 기존 미국 23:35 예약은 취소/교체/연장하지 않았다.

가짜 데이터로 미리보기 무접속·정상 SIGTERM/새 OS 프로세스·증거 없는 조기 종료·종료 거부 시 소유 자식만 SIGKILL·부모 취소·이력 변조/요약 불일치를 검사했다. 실제 broker는 테스트 코드에서 사용하지 않는다.
