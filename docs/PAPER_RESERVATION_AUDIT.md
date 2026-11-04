# Paper 예약 기록 분류

`auditPaperValidationRecord`는 이미 읽은 입력의 오류를 민감값 없이 분류하는 순수 helper다. 파일·DB·broker·프로세스에 접근하지 않는다. 기존 `summarizePaperValidation`의 검증과 `createPaperValidationStatus`의 제외 집계는 변경하지 않는다. CLI/API 연결이나 예약 예외 등록 기능은 추가하지 않았다. 새 의존성은 없다.

## 확인된 기록

읽기 전용 조사 대상은 `a4072920-6191-48e9-bc0e-76def63dd4a0`이다. 해당 디렉터리에는 일반 파일 `result.json`만 있고 `request.json`은 없다. 상태 reader는 ENOENT를 null로 전달하므로 요청 객체의 Zod 검증에서 `invalid_type`, 최상위 path `[]`로 거부된다. 이 오류는 원장 필드나 계좌 값의 형식 오류가 아니다.

종료 파일은 실행 전 중단, `runStarted=false`, 0 tick, `waiting` 단계, `PAPER_BUILD_CHANGED`를 보고한다. 감사 당시 실행기는 try 안의 build fingerprint 검사 후 요청 파일을 기록하고, 그 검사에서 예외가 발생해도 finally에서 종료 파일을 기록하는 경로가 있었다. 따라서 파일 구성과 보고된 오류는 그 실패 경로에 부합한다. 다만 누락된 요청으로 당시 코드·계획·계좌·예약 구간을 연결할 수 없으며, 현재 코드 구조만으로 과거 실행 경로와 프로세스 종료를 독립적으로 증명하지 않는다.

원본 파일과 기존 private 자료는 수정·삭제하지 않았다. 신규 시세/API 호출, Paper 원장 접근, 예약/관측 프로세스 제어, 마이그레이션도 하지 않았다. 기존 미국 Paper 예약의 고정 빌드는 변경하지 않았다.

## 분류와 한계

helper는 고정된 classification만 반환한다.

- `invalid-id`: UUID 형식 거부
- `request-missing-or-null`: 요청 입력이 null 또는 undefined
- `request-invalid`, `result-invalid`: 요청 또는 종료 스키마 거부
- `before-invalid`, `after-invalid`: checkpoint 스키마·hash·출처 거부
- `review-invalid`: 대사 스키마 거부
- `linked-evidence-invalid`: 파일 간 연결·hash·상태 의미 등 나머지 상태 검증 거부
- `status-readable`: 기존 상태 요약 검증을 통과

메모리의 null만으로 파일 누락과 JSON null을 구분할 수 없으므로 helper는 둘을 합쳐 표시한다. 이번 실제 기록의 파일 누락은 별도의 읽기 전용 디렉터리 검사로 확인했다. 처음 확인된 차단 원인을 반환하며 다른 모든 입력까지 검증했다고 주장하지 않는다. 선택적 진단 오류는 기존 상태 조회와 동일하게 진단 unavailable로 처리된다.

반환값에는 원본 객체·오류 메시지·Zod 동적 경로·계좌·PID·파일 경로가 없다. 모든 분류에서 `canIgnoreReservation=false`, `processLivenessChecked=false`, `ledgerReviewRecomputed=false`, `executionEnabled=false`, `canResume=false`다. `status-readable`도 예약 무시·프로세스 생존 확인·실행 권한을 뜻하지 않는다.

## 비파괴 처리와 남은 차단

현재 증거만으로는 안전하게 예약 차단을 해제할 수 없다. `rejectedCount`는 그대로 유지되고 유한 관측 감독기의 `SUPERVISOR_RESERVATIONS_UNVERIFIED`도 유지된다. UUID/날짜/오류 코드 allowlist, 만료 기한 추정, 누락 요청 재구성, 결과 파일 이동/수정/삭제로 제외 수를 줄이지 않는다.

후속 해소가 필요하면 원본을 보존한 별도 확인 증거 형식과 감독기 검증을 먼저 설계해야 한다. 최소한 정확한 원본 파일 집합과 바이트 hash, 누락 파일 목록, 확인 근거·확인 범위·시각을 연결하고 원본 변경·새 파일 추가 시 다시 차단해야 한다. 소유자가 직접 시작한 프로세스의 종료 증거 등 독립적으로 연결 가능한 자료와 검토가 필요하다. PID 검색·기한 경과·이 종료 파일의 자기 보고만으로 대체할 수 없다. 계좌 현재 정지 상태도 과거 미실행 증명은 아니다. 단순 확인서나 hash 자체를 실행 승인으로 취급하지 않는다. 그러한 예외 검증은 이번 패치에 구현하지 않았다.

## 검증

요청 누락과 종료 파일만 있는 합성 기록이 계속 rejectedCount=1로 남고 원본 파일 집합/내용이 유지되는 회귀 검사를 추가했다. 입력별 고정 분류·민감값 비노출·연결 불일치·정상 조회의 권한 비확대도 검사한다. 실제 조사 기록을 source helper로 읽기 전용 분류했으며 `request-missing-or-null`, `canIgnoreReservation=false`를 확인했다. 원본 보정이나 실제 실행은 검증 범위에 포함하지 않는다.

추가 읽기 전용 추적에서는 가까운 시각의 batch와 보존된 script hash의 일치를 확인했으나 로그가 연결한 실행 UUID는 조사 대상과 달랐다. 조사 대상 UUID를 직접 참조하는 독립 launch/exitCode/signal 종료 증거는 찾지 못했으므로 시각이나 같은 오류로 연결하지 않았다. 새 private 감사 `cd428828-bc3a-4461-960c-cadbecded5b2`에는 원본 파일 집합/바이트 hash와 고정 분류만 보관했다. 원본 변경이나 차단 예외는 없다.

향후 재발 방지를 위해 실행기의 두 번째 빌드 검사를 요청 파일 기록 뒤로 이동했다. 사전 입력/빌드 검증은 유지하며 기존 고정 빌드/과거 실패 기록에는 소급 적용하지 않는다. 이는 미래 실패 기록의 연결성을 보강하는 수정으로 과거 불확실성을 해소하지 않는다.
