# 일회용 파일·컨테이너 권한 실험

[실행 환경 분리 설계](RUNTIME_SECRET_ISOLATION_DESIGN.md)의 후속 실험이다. 새로 만든 Docker 볼륨의 **가짜 비밀값**만 사용해 UID·파일/디렉터리 권한·마운트의 효과를 확인한다. 기존 컨테이너·볼륨·host 파일/사용자·실제 자격·DB·원본 예약을 읽거나 변경하지 않는다. 운영 환경의 전체 격리/권한 폐기 확인서가 아니다.

## 실행

Node 24, 빌드된 공통/worker 패키지, 로컬 `/var/run/docker.sock`과 캐시된 `node:24-slim` 이미지가 필요하다. 이 이미지는 기존 Dockerfile의 Node 24 실행 계열을 재사용하며 새 앱 의존성/상시 서비스는 없다. 실험 명령은 이미지를 자동 pull하지 않는다. CI는 전체 검사 전에 공개 이미지를 명시적으로 준비한다.

```bash
corepack pnpm build:packages
corepack pnpm --filter @hth/worker build

# 기본: 파일/컨테이너 생성 없는 미리보기
corepack pnpm runtime:secret:lab

# 로컬 Docker의 새 일회용 자원에서만 실행
corepack pnpm runtime:secret:lab --execute
```

`--execute` 한 개만 허용한다. 사용자 경로·내용·계좌·URL·컨테이너·볼륨·apply/resume 인자는 없다. TRADING_MODE는 paper/default만 허용하고 환경파일은 로드하지 않는다. DOCKER_HOST/현재 context·등록된 registry 자격 대신 빈 임시 Docker 설정과 명시적 local socket을 사용한다. 기존 DB 권한 실험의 CLI/코드는 변경하지 않았다.

## 실험 구성

매번 새 UUID 이름/nonce label의 local driver 볼륨 하나를 만들고 이름·label·driver·외부 옵션 부재를 확인한 뒤 사용한다. 기존 이름/자료를 입력받지 않는다. 볼륨은 여러 컨테이너에 같은 자료를 공유하는 부정 사례를 재현하기 위해 사용하며, 가짜 값만 저장하고 종료 시 명시적으로 제거한다. host bind mount나 앱 자료 복사는 없다.

새 컨테이너 3개는 모두 network=none·공개 포트 없음·read-only rootfs·cap-drop ALL·no-new-privileges로 만든다. 생성한 ID/label·network/권한·마운트 집합/볼륨 이름/읽기 전용 여부를 확인하고 다른 마운트나 host PID/privileged 설정을 거부한다.

| 컨테이너         | 볼륨 접근              | 역할                                                                                |
| ---------------- | ---------------------- | ----------------------------------------------------------------------------------- |
| owner fixture    | 새 볼륨 read-write     | 초기 root 프로세스에 CHOWN만 추가해 볼륨 소유권을 설정. 값/파일은 UID 1000으로 생성 |
| shared fixture   | 같은 새 볼륨 read-only | UID 1000 또는 1001의 읽기/쓰기 시도로 공유 경계를 확인                              |
| isolated fixture | 마운트 없음            | UID 1000이어도 같은 경로가 제공되지 않음을 확인                                     |

root/CHOWN은 **초기화 fixture만의 권한**이며 앱/구실행에 관리 권한을 주는 설정 예시가 아니다. 접근 probe는 UID=GID 1000/1001·effective capability 0·NoNewPrivs=1을 검사한다. root 보조 그룹을 거부하고 다른 UID의 경우 1000 보조 그룹도 거부한다. 원인 불명의 프로세스 실패를 접근 거부로 바꾸지 않는다.

가짜 값은 컨테이너 안에서 매번 새로 생성한 64자 hex다. owner가 만든 파일은 0600/0644, 디렉터리는 0700/0755로 구분한다. 실제 값은 출력하지 않고 내부 hash/길이로 같은 가짜 값인지 비교한다. hash·경로·UID별 원본 출력도 최종 DTO에 포함하지 않는다.

## 8가지 검사와 해석

| 검사                                   | 통과하려면 실제로 확인할 결과                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------------- |
| sameUidSharedRead                      | 다른 컨테이너라도 동일 UID·공유 볼륨이면 0600 파일 읽기 성공                          |
| sameUidPrivateDirectoryRead            | 같은 UID는 0700 디렉터리의 0600 파일도 읽음                                           |
| differentUidFileDenied                 | UID 1001은 0755 디렉터리 안의 0600 파일에서 정확히 EACCES                             |
| differentUidDirectoryDenied            | UID 1001은 0700 디렉터리의 파일에서 정확히 EACCES                                     |
| worldReadableBypassesUidSeparation     | 0644 파일은 UID 1001도 같은 가짜 값을 읽음. UID 분리만으로 충분하지 않은 부정 사례    |
| unmountedSecretAbsent                  | 볼륨이 없는 컨테이너의 같은 경로는 정확히 ENOENT. 모든 우회 경로 부재로 확대하지 않음 |
| readOnlyMountStillReadable             | read-only 마운트에서도 허용 UID의 읽기는 성공                                         |
| readOnlyWriteDeniedAndContentPreserved | 허용 UID의 append 시도가 정확히 EROFS이고 owner의 후속 내용 hash/길이는 동일          |

예상하지 않은 errno·내용 불일치·Docker/권한/시간 초과는 실패다. read-only는 쓰기 통제이며 읽기 차단 자체가 아니라는 [공식 볼륨 문서](https://docs.docker.com/engine/storage/volumes/)와 [UID/런타임 권한](https://docs.docker.com/engine/containers/run/)을 참고했다. 위 결과는 실제 실험 대상의 동작만 나타낸다.

## 신뢰 경계·실패·정리

결과 state=passed는 fixture의 8조건과 정상 정리 완료만 뜻한다. syntheticOnly=true이며 hostIsolationVerified/daemonAccessRevoked/operatingEvidence/policyApplied/reservationExceptionsCreated/executionEnabled/canResume는 모두 false다. 동일 daemon을 관리하는 실행 주체가 통제된 실험을 수행한 것이며, 구 host/예약/관리자 권한이 폐기됐다는 독립 증거는 아니다. [Docker 관리 권한의 경계](https://docs.docker.com/engine/security/)

미리보기/통과는 exit 0, 실패는 exit 1과 고정 단계 코드만 출력한다. 비밀값·오류 원문·관리 명령 출력·원본 receipt·자원 식별자는 출력하지 않는다. 실제 broker/네트워크·DB/계좌·관측/재개는 시작하지 않는다.

정리는 직접 얻은 container ID를 역순으로 제거한 뒤 소유가 확인된 볼륨만 제거한다. 컨테이너 정리에 실패하면 볼륨 제거를 시도하지 않고 CLEANUP_FAILED로 남긴다. 불확실 create나 소유 receipt 불일치에서는 이름을 추측해 삭제하지 않는다. 자동 재시도·전체 prune·기존 서비스 중지는 없다. 강제 종료/전원/daemon 장애 시 정리는 보장하지 않으며, 소유자가 Docker 관리 화면에서 `hth.runtime-secret-lab` label의 테스트 자원만 검토한다. 잔존 가능한 자료도 가짜 값뿐이다.

## 자동 검사와 다음 범위

단위 테스트는 CLI 미리보기/잘못된 인자·환경파일/민감값 비노출·remote Docker 설정 무시, 볼륨/컨테이너 receipt 범위·권한·추가 mount 거부, 불확실 생성과 소유 정리/정리 실패를 가짜 Docker로 검사한다. pre-commit은 관련 단위만 실행한다.

`runtime-secret-lab.integration.test.ts`는 기존 TEST_DATABASE_URL 통합 suite 활성 조건과 전용 URL 형식 검사만 재사용한다. 그 DB에 연결하지 않으며 새 Docker 자원만 만든다. suite 활성 상태에서 Docker/socket/이미지가 없거나 프로브 결과가 다르면 실패한다. 단위 실행에서 통합을 생략한 결과는 전체 검증으로 표시하지 않는다. CI의 `docker pull node:24-slim`은 공개 테스트 이미지 준비이며 배포/worker 시작이 아니다.

운영 file loader·IPC 인증 변경·OS 주체/daemon 접근 폐기·실제 secret 공급·broker 회수·scope 이전·예약 예외는 구현하지 않았다. 다음 후보는 기존 환경변수 입력과 충돌을 거부하는 파일형 secret 입력의 구현/가짜 파일 검사이며, 앱에 실제 파일/키를 설정하는 작업은 별도다. 현행 a407 차단과 Paper 정지는 유지한다.

## 2026-11-10 검증 결과

관련 단위 34개와 실제 새 Docker 자원의 통합 1개를 통과했다. root CLI의 preview/execute 8조건을 확인했고 마지막 probe는 effective capability 0/NoNewPrivs=1도 검사했다. 별도 일회용 localhost 전용 DB의 최종 로컬 verify:ci는 140파일·1,310개 테스트(테스트 구간 74.81초), 포맷·린트·타입·전체 빌드를 통과했다. 두 Compose 설정·문서 링크·diff도 통과했다. 실험 컨테이너/볼륨 정리 후 해당 label의 잔존이 없음을 확인했다. 원격 CI나 실제 host/daemon 권한 폐기·운영 격리 증거는 아니다.
