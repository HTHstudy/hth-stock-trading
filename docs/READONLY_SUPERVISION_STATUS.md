# 읽기 전용 관측 감독 기록 조회

`readonly-supervision-status.ts`는 기존 감독기의 `.local-data/readonly-supervisions/<UUID>/request.json`과 `result.json`만 읽는다. CLI 전용 로컬 도구이며 서버 JSON 계약이나 새 의존성을 추가하지 않는다. HTTP에 연결하지 않는다.

## 사용과 범위

메인 작업에서 package script를 등록하기 전에는 다음 명령으로 소스 CLI를 조회할 수 있다. 기존 workspace 의존성과 패키지 산출물이 준비되어 있어야 한다. 이 명령은 빌드·환경파일 로딩·DB·토큰·관측·자식 프로세스·재예약·거래 재개를 수행하지 않는다.

```bash
node --import tsx apps/worker/src/readonly-supervision-status-run.ts
```

인자를 받지 않는다. 출력 경로·PID·계좌·실행 옵션을 전달할 수 없다. `TRADING_MODE`는 미설정 또는 paper만 허용한다. 소스와 dist 모두 모듈 위치 기준 저장소 고정 루트에서 읽는다. `createReadonlySupervisionStatus(root?, now?)`의 루트/시계 주입은 서버 조립 및 가짜 파일 테스트용이며 CLI 입력에 노출하지 않는다. helper 인스턴스는 연속 조회 시계 역행도 검사한다.

## 파일 검증

- 모든 객체는 strict Zod로 검증한다. 디렉터리 UUID와 request/result ID가 같아야 한다.
- 계획 전체를 기존 순수 계획기로 재계산한다. 계산된 예산·표본 수·예약·차단 여부 및 비활성 kind 필드까지 비교하고 prepared 계획만 허용한다.
- request의 plan/source/instrument 결합 hash와 result의 본문 hash를 검증한다. source·planHash·buildHash·UUID가 request와 연결되어야 한다. demo는 감독기의 고정 KR:005930만 허용한다.
- 완료는 verify 단계·오류 없음·비강제 정리 확인·표본 수·healthy/closed/blocked 합계를 검사한다. 실패에는 허용된 코드만 허용하며 완료 집계가 섞이면 거부한다.
- 루트·부모 경로·UUID 디렉터리 symlink를 검사한다. 파일은 O_NOFOLLOW/O_NONBLOCK으로 열고 일반 파일만 읽는다. 각 파일 64KiB, 디렉터리 스캔 256개, 처리 기록 100개 상한을 적용한다. 상한 이후 추가 항목이 있으면 limited=true다. 중간 디렉터리 inode 및 파일 크기/수정시각 변화도 검사한다.
- 루트 또는 부모가 없으면 not-recorded, 접근 불가·비디렉터리·symlink면 unavailable이다. 개별 기록 손상은 rejectedCount로만 집계하며 원본 오류·파일명·경로는 출력하지 않는다. 루트 검증이 실패하면 부분 결과도 폐기한다.

서버 소유자의 private 로컬 파일이 전제다. checksum은 서명이나 운용 승인이 아니다. 동일 UID가 파일과 hash를 함께 바꾸거나 부모 경로를 교체하는 모든 경쟁을 원자적으로 막는 보장은 없다. 현재 실행 코드 fingerprint나 관측 journal을 다시 읽지 않으므로 `currentBuildChecked=false`, `observationEvidenceRecomputed=false`다. 검증된 hash는 저장된 request/result 사이의 연결 검사다.

## 상태 해석

request만 있으면 `state=awaiting-result`, 종료 기록 없음이다. 이는 프로세스 실행/대기/실패를 확정하지 않는다. `deadlineElapsed`는 검증 가능한 조회 시각과 deadline의 비교이며 기한 경과로 상태를 변경하지 않는다. PID·프로세스·DB에 접근하지 않으며 `processLivenessChecked=false`를 유지한다.

요청/종료의 미래 시각, 종료의 요청 이전 시각, 완료가 계획 시작 이전 또는 정리 cutoff 이후인 경우, 기록의 SUPERVISOR_CLOCK_CHANGED, helper 조회 시계 역행 또는 비유한 시계는 `clockUnverified=true`, `deadlineElapsed=null`이다. 예정 startsAt이 미래라는 이유만으로 시계 이상으로 표시하지 않는다.

`observation-completed`는 저장된 감독 결과다. `tokenExpiryVerified=false`, `sessionBoundaryVerified=false`, `paperLedgerCompared=false`를 그대로 보존하며 자연 갱신·세션 전환·Paper 보존을 추가 승인하지 않는다. 출력은 감독 UUID·출처·종목·종류·허용 시각·계획/빌드 hash·허용 실패 코드·표본 집계·정리 여부와 검증 경계만 제공한다. 원본 plan·관측 ID·journal hash·경로·PID·계좌·키·로그는 반환하지 않는다.

CLI는 unavailable·손상 제외·상한 도달·시계 검증 불가 또는 설정 오류에 exit 1, 정상 조회와 not-recorded에 exit 0이다. 저장된 감독 실패 자체는 조회 실패가 아니므로 정상 검증된 실패 기록은 exit 0일 수 있다. 자동 실행·재시도는 없다.

## 검증

테스트는 임시 디렉터리의 가짜 request/result와 주입 시계만 사용한다. 요청 단독·정상 완료·강제 종료 기록·해시 및 연결 변조·계획 재계산·미래/역행 시각·symlink·비일반/과대 파일·스캔 상한·접근 불가·민감 출력 누락을 검사한다. 실제 API·DB·토큰·관측 프로세스를 사용하지 않는다. 기존 감독기와 package script는 변경하지 않는다.

이번 서브작업에서 해당 파일 테스트 35개, worker의 noEmit 타입 검사, 도구/테스트 tsconfig의 noEmit 타입 검사, 새 TypeScript 파일 3개의 ESLint 및 네 파일의 Prettier 검사를 통과했다. 전체 테스트·DB 통합·빌드·실제 조회 CLI 실행은 수행하지 않았다. 빌드 산출물·예약·운영 프로세스는 변경하지 않았다.
