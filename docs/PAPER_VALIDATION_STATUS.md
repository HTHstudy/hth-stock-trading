# 저장된 Paper 실행 상태 조회

`paper:validation:status`는 서버 로컬 CLI다. 기존 실행이 남긴 파일만 읽으며 키·DB·토큰·broker·worker를 생성하지 않는다. 실제 시세 수집, Paper 관측/재개/정지, 거래일 승인, 주문, 마이그레이션도 수행하지 않는다. 기존 Zod와 공개 Paper 검토 계약/hash 함수를 재사용하며 새 의존성은 없다.

```bash
corepack pnpm paper:validation:status
```

이 명령은 빌드를 자동 실행하지 않는다. 기존 공통 패키지 산출물이 있는 개발 환경에서 tsx로 실행하며 서버 `.env`를 자동 로드하지 않는다. 최초 설치는 별도 빌드가 필요하다. 승인된 Paper 실행이 기존 빌드를 고정해 기다리는 동안에는 그 산출물을 덮어쓰지 않는다. 이번 개발의 빌드·검사는 별도 worktree에서 수행한다.

## 입력과 출력 경계

고정 `.local-data/paper-validation-runs`의 UUID 디렉터리만 읽는다. CLI 인자·사용자 파일 경로·계좌 ID를 받지 않는다. 웹 연결은 [별도 인증·설정 계약](PAPER_VALIDATION_WEB.md)을 따른다. 실행 요청/종료 기록과 `before.json`·`after.json`·`review.json`의 strict schema/hash 및 연결을 검사한다. root·디렉터리·파일 symlink와 비일반 파일을 거부하며 경로를 다시 확인한다. 조회로 디렉터리나 파일을 생성하지 않는다.

최대 100개 경로 스캔·50개 결과·총 64MiB 읽기 예산이다. 요청/종료 파일은 각각 16KiB, checkpoint는 각각 32MiB, 대사는 1MiB 이하다. `limited`와 `rejectedCount`를 함께 표시한다. 누락·부분 파일·변조로 제외한 수는 실제 Paper 실행 실패 횟수가 아니다. UUID·디렉터리 순서·mtime을 최신 실행 순서로 해석하지 않는다.

출력에는 계좌·전략·주문/체결 식별자, scope, lease token, DB URL, 파일 경로, PID, 원본 로그·감사 상세, 현금/보유분/원가 원본을 포함하지 않는다. 대사 검사도 허용한 고정 이름과 passed/failed/unverified만 제공한다. 로컬 실행 UUID는 해당 증거 묶음 식별자다. 자료가 없는 root는 not-recorded, 접근/형식이 잘못된 root는 unavailable로 구분한다.

## 상태의 의미

- `awaiting-result`: 요청은 있지만 종료 기록이 없다. 시작 예정 시각·기한을 표시하되 실행 중/멈춤/실패/프로세스 생존을 추정하지 않는다. 기한 경과는 `deadlineElapsed`이며 실제 실패 원인이 아니다.
- `terminal-recorded`: 종료 파일을 읽었다. `resultState`가 미완료/실패/조기 종료를 그대로 구분한다. tick 수는 종료 파일이 보고한 수이며 연속 실행의 독립 증명이 아니다.
- `evidence`: request-only, before-checkpoint, after-checkpoint, linked-review는 검증한 파일의 수준이다. checkpoint 보유 자체가 실행 시작·완료 증거는 아니다.
- `verdict=incomplete`: 체결/의도 등 검증 경로가 부족하다. 60 tick 또는 원장 보존을 수익성·체결 검증 성공으로 바꾸지 않는다.
- 미래 시각이나 checkpoint→대사→종료 순서의 역행(마이크로초 포함)은 `clock=unverified`다. 현재 데이터 신선도·시장 준비도 검사가 아니다.

조회는 대사의 계산을 재실행하지 않으므로 `ledgerReviewRecomputed=false`, PID를 검사하지 않으므로 `processLivenessChecked=false`다. `linked-review`는 저장된 schema·checksum·checkpoint 연결 검사이며 모든 hash를 재계산한 위조나 원천 데이터 진위를 인증하지 않는다. 모든 결과에서 executionEnabled/canResume는 false다. 상태 조회 결과로 worker나 거래를 자동 시작하지 않는다.

선택적 `diagnostics.json`은 [구간 진단 계약](PAPER_RUN_DIAGNOSTICS.md)의 before/after hash·scope·진단 이벤트 전체 집합·batch hash를 검증한 뒤 집계만 제공한다. 진단 파일 오류는 실행 기록 자체를 숨기지 않고 별도 unavailable로 표시한다. 조회가 DB에 연결하거나 파일을 생성하지 않는다.

대사 보고서 자체의 검사/한계는 [Paper 실행 전후 검토](PAPER_RUN_REVIEW.md), 실제 일회성 실행 기록은 [운영 검증](OPERATIONAL_VALIDATION.md)을 따른다. 브라우저 조회는 [소유자 인증·loopback 계약](PAPER_VALIDATION_WEB.md)으로 연결하며 조회 helper를 직접 외부 입력에 노출하지 않는다.

서버 소유자만 증거 디렉터리를 작성할 수 있는 로컬 환경을 전제로 한다. 사전/사후 realpath와 최종 파일 O_NOFOLLOW 검사는 OS의 openat 같은 원자적 디렉터리 고정이 아니다. 악의적인 동일 권한 프로세스가 부모 디렉터리를 교체하는 경쟁까지 차단한다고 보장하지 않는다. 다른 사용자·비신뢰 프로세스가 쓸 수 있는 디렉터리나 권한이 높은 계정의 대리 조회로 사용하지 않는다. 외부 입력을 받는 서비스로 연결하기 전에는 해당 경계를 별도로 재검토한다.
