# 원본 보존형 Paper 예약 정리

누락된 과거 요청을 복원하지 않고, **독립적으로 수집한 소유 프로세스 종료 증거가 있는 경우에만** 해당 기록을 현재 예약 충돌 검사에서 정리한다. 과거 실행 성공·원장 정리·체결·수익성 검증으로 바꾸지 않는다. 실제 주문·Paper 재개·관측 시작·마이그레이션은 이 기능의 범위가 아니다.

## 세 가지 자료

1. 원본 `.local-data/paper-validation-runs/<runId>/`: 이번 MVP는 `result.json`만 있고 request/before/after/review가 없는 경우로 한정한다. 디렉터리의 정확한 파일 집합·원본 바이트 수·SHA-256을 고정한다. 파일 추가·내용 변경·symlink·16KiB 초과를 거부한다.
2. [직접 생성한 프로세스의 증거](OWNED_PAPER_VALIDATION.md): `.local-data/paper-validation-processes/<launchId>/launch.json`, `exit.json`. 새 run UUID·nonce·runner/인수 hash·launch hash를 연결하고 직접 보유한 ChildProcess의 close/error에서 종료 코드를 수집한다. PID 검색/재연결이나 수동 확인으로 대신하지 않는다.
3. 별도 처리 기록 `.local-data/paper-reservation-closures/<runId>.json`: 위 snapshot·launch·exit·terminal의 hash와 확인 시각을 연결한다. 기존 파일을 바꾸지 않고 0600 원자적 새 생성으로 기록한다. 같은 파일의 덮어쓰기·자동 재시도는 없다.

JSON은 기존 Zod strict 계약으로 검증한다. 처리 범위는 `retire-reservation-only`, historicalOutcomeVerified/executionEnabled/canResume는 false다. checksum은 서버 소유자 전용 파일의 내용 연결 검사이며 작성자 서명이나 악의적인 동일 UID 작성자에 대한 인증은 아니다.

## 허용 조건

현재는 원본 terminal이 `stopped-before-run-or-failed`, phase=waiting, runStarted=false, completedTicks=0, code=PAPER_BUILD_CHANGED인 경우만 지원한다. running tick·체결/의도·대사 verdict가 있거나 다른 실행 단계/오류라면 거부한다. 이는 이번에 발견한 요청 기록 이전 실패 경로를 좁게 지원하는 조건이다.

독립 launch의 runId와 실제 전달한 run-id가 연결돼야 하고 exit의 launchId/runId/nonce/launchHash가 일치해야 한다. exit 본문 hash·강제 종료 아님·signal=null·exitCode=1·시계 확인을 요구한다. launch ≤ terminal ≤ 직접 관찰한 exit ≤ 현재 시각이어야 한다. 최대 마이크로초 정밀도를 보존해 비교하며 그보다 정밀한 증거 시각은 거부한다. exit code 1은 해당 실패 경로와의 일관성 검사이며 그 코드 하나로 정리를 승인하지 않는다.

처리 계획의 hash를 고정한 뒤 별도 apply에서 최신 원본/증거를 다시 확인한다. 적용 전후 변경이 발견되면 성공으로 반환하지 않으며 이후 예약 조회에서도 다시 차단한다. 파일 시스템/동일 UID의 악의적인 경로 교체까지 원자적으로 막는 서명 시스템은 아니며 신뢰된 로컬 서버 소유자 환경을 전제한다.

## 명령

기존 빌드가 필요하며 명령은 빌드·환경파일·키·DB 연결을 자동 실행하지 않는다. 기본은 무접속 미리보기다.

```bash
corepack pnpm paper:reservation:closure

# launchId가 없으면 근거가 필요하다는 blocked/exit 2만 반환한다.
corepack pnpm paper:reservation:closure --inspect --run-id=<RUN-UUID>

# 이미 존재하는 독립 증거를 명시해 검토한다. PID/임의 파일 경로는 받지 않는다.
corepack pnpm paper:reservation:closure --inspect \
  --run-id=<RUN-UUID> --launch-id=<OWNED-LAUNCH-UUID>

# 검토된 plan hash와 같은 자료에 대해서만 별도 처리 기록을 생성한다.
corepack pnpm paper:reservation:closure --apply \
  --run-id=<RUN-UUID> --launch-id=<OWNED-LAUNCH-UUID> \
  --plan-hash=<PLAN-HASH> --confirm=RETIRE_ORPHANED_RESERVATION
```

inspect는 읽기 전용이며 처리 기록을 만들지 않는다. apply의 확인 문자열은 실제 종료 증거를 대신하지 않는다. 외부 HTTP/브라우저 조작은 추가하지 않았다. 실패 출력은 고정 코드이며 원본 예외·계좌·PID·경로를 출력하지 않는다.

## 예약 검사와 과거 조회

기존 `.list()`와 웹 DTO의 rejectedCount는 그대로다. 원본에 요청이 없다는 과거 오류를 성공이나 정상 조회로 바꾸지 않는다.

서버 내부 `.checkReservations()`만 rejectedCount와 별도로 retiredCount/unresolvedCount를 계산한다. 정리 기록·현재 원본·소유 종료 증거를 매번 재검증한 경우에만 해당 한 건의 unresolvedCount가 감소한다. 전체 처리 기록을 예약 스캔 전후에 각각 최대 100건 검증한다. 처리된 원본이 삭제되거나 유효한 요청 추가로 과거 상태 조회가 가능해져도 그 처리 기록의 원본 불일치를 놓치지 않는다. 두 번의 검증이 달라지면 unavailable로 차단한다. 다른 미확인 기록·읽기 실패·상한 초과·새로운 정상 요청의 충돌은 계속 차단한다. 감독기는 대기 전과 시작 직전에 이 검사를 한다. 조회가 처리 기록을 작성하거나 실행을 재개하지 않는다.

## 기존 a407 기록

`a4072920-6191-48e9-bc0e-76def63dd4a0`에는 아직 연결된 독립 소유 종료 증거가 없다. 이번 구현으로 과거의 exit를 만들어내거나 다른 run의 증거를 옮기지 않는다. 실제 적용은 하지 않았으며 해당 기록의 차단은 유지한다. 현재 계좌 정지·인증 잠금 획득·기한 경과·종료 파일의 자기 보고는 이 근거를 대체하지 않는다.

향후 직접 실행하는 Paper 검증에는 소유 프로세스 래퍼를 사용해 이 증거를 처음부터 기록할 수 있다. 현재 대기 중인 미국 Paper 실행을 취소하거나 새 래퍼로 교체하지 않았다. 이전 고정 빌드/과거 실패 파일도 보존한다.

## 검증

합성 원본과 독립 launch/exit fixture로 명시적 적용·과거 rejectedCount 보존·예약만 정리되는 경로를 검사한다. 원본 바이트 변경·파일 추가·증거/처리 hash·run ID/nonce 불일치·강제 종료·미래/역행 시각·실제 실행 흔적·symlink·크기 상한·중복 적용은 거부한다. 래퍼는 가짜 launcher/ChildProcess로 검사하며 테스트에서 실제 broker나 Paper 실행을 시작하지 않는다.

최종 기본 테스트 82파일·563개와 타입·린트·전체 빌드·포맷 검사를 통과했다. DB 통합 102개는 기본 실행에서 제외됐다. 독립 검토에서 발견한 조회 중 원본 변경과 마이크로초 시각 역전은 재현 테스트로 보완했고, 처리된 원본의 삭제·정상 요청 추가도 다시 차단하는 것을 확인했다.

실제 저장소 읽기 전용 확인에서는 원본 result 바이트 hash가 최초 감사와 같았고 rejectedCount=1/unresolvedCount=1/retiredCount=0이었다. 처리 기록은 적용하지 않았다. 현재 미국 Paper 예약의 고정 빌드 hash도 보존됐다. 두 새 CLI의 기본 미리보기와 종료 근거 미지정 시 blocked 출력을 확인했으며 실제 Paper 실행·시세 수집은 시작하지 않았다.
