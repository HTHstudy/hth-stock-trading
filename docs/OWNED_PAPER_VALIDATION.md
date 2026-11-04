# 소유 Paper 프로세스의 독립 종료 증거

`owned-paper-validation-run.ts`는 신뢰된 서버 소유자가 새로 시작하는 일회성 Paper runner 전용 래퍼다. HTTP나 브라우저 입력으로 root·인수·launcher를 전달하지 않는다. 기존 PID에 연결하지 않으며 자신이 직접 생성한 ChildProcess의 close/error만 관찰한다. 기본 실행은 미리보기로 파일·DB·자식 프로세스를 만들지 않는다.

실행에는 `TRADING_MODE=paper`, `--execute`, runner의 `--run`, `--resume-authorized`가 모두 필요하다. 나머지 인수는 runner의 실제 옵션만 strict parse하고 중복을 거부한다. fingerprint/verify-inputs/selfcheck-control은 실행 옵션과 혼합할 수 없다. 사용자 `--run-id`, PID, 임의 실행 파일은 받지 않는다. 운영 전 main의 runner가 `--run-id`를 지원하는 버전인지 확인해야 한다. 개발 검증에서는 실제 `--execute`를 호출하지 않는다.

래퍼가 서로 다른 새 launch UUID·run UUID·nonce를 만들고 `--run-id=<새 UUID>`를 runner에 전달한다. 기존 run 폴더가 있으면 실패하며 새 run 폴더는 runner만 생성한다. runner 경로는 서버 root의 `infra/authorized-paper-validation.mjs`, Node는 현재 프로세스의 `process.execPath`로 고정한다. cwd는 root이고 stdout/stderr는 ignore다. 환경변수는 `TRADING_MODE=paper`와 PATH/LANG/TZ만 전달한다. 키·NODE_OPTIONS·부모 환경 전체를 복사하지 않는다. runner 자체의 서버 환경파일 읽기와 기존 명시적 실행/CAS 절차는 유지된다. 래퍼 자체는 API·원장·마이그레이션을 호출하지 않는다.

고정 루트 `.local-data/paper-validation-processes/<launchId>/`에 다음 파일을 새로 기록한다. 디렉터리는 0700, 파일은 0600이다. 임시 파일 fsync 후 hard link로 완성 파일을 원자적으로 공개하며 기존 파일을 덮어쓰지 않는다. 심볼릭 링크 저장 디렉터리와 runner를 거부한다.

- `launch.json`: 공통 `ownedPaperLaunchSchema`. runner 원본 바이트 SHA-256과 **Node에 전달한 인수 배열 전체**(runner 절대 경로, wrapper가 추가한 run-id 포함)의 contentHash를 기록한다. 키와 원본 인수는 기록하지 않는다.
- `exit.json`: 공통 `ownedPaperExitSchema`. launchHash·runId·nonce를 연결하고 hash를 제외한 본문 contentHash를 보존한다. 종료 코드/신호는 소유 자식의 close/error에서만 얻는다. spawn error는 코드/신호 null로 기록하며 원문 오류를 남기지 않는다.

SIGTERM/INT는 CLI AbortController로 전달한다. 래퍼는 자신의 자식에 SIGTERM을 보내고 15초 후 SIGKILL로 강제 종료한다. 이후 5초 안에 종료를 관찰하지 못하면 실패하며 exit.json을 만들지 않는다. 강제 종료·취소·시계 역행·비정상 코드·미지원 신호·spawn 오류는 성공으로 표시하지 않는다. 자동 재시도와 후속 프로세스 시작은 없다. 부모의 SIGKILL/전원 종료 시에도 exit 파일이 없을 수 있으며 미종료를 종료로 추정하지 않는다.

이 증거는 **래퍼가 미래에 직접 생성한 runId에만** 연결된다. 과거 a407 기록에 종료 증거를 소급 생성하지 않는다. 종료 관찰은 Paper 대사·토큰 정리·원장 보존·관측 품질 또는 재개 권한을 의미하지 않는다. 예약 폐쇄 검증기는 별도로 launch/exit/hash/실행 결과를 검증해야 한다. 모든 계약의 executionEnabled/canResume는 false이고 launch의 automaticRetry도 false다.

검증은 가짜 launcher와 synthetic ChildProcess만 사용한다. 실제 runner·broker·DB를 시작하지 않는다. package script·runner run-id 지원·폐쇄 검증기 연결은 main 작업에서 담당한다.

등록된 명령은 `corepack pnpm paper:validation:owned`이며 기본 미리보기다. CLI는 모듈 위치로 workspace root를 고정하므로 pnpm filter의 cwd에 의존하지 않는다. CLI의 기본 모드는 paper이고 명시적 live는 거부한다. 실제 실행 인수는 위 명시적 조건과 원래 runner의 모든 고정 입력/시각/제어 검증을 충족해야 한다. `paper:reservation:closure`와의 연결/한계는 [예약 정리 절차](PAPER_RESERVATION_CLOSURE.md)를 따른다.
