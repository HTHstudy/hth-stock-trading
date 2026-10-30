# 관측 중 계좌 현황 조회

## 인증과 요청

토스 공식 FAQ는 client당 유효 토큰이 하나이며 재발급하면 이전 토큰이 무효화된다고 설명한다. 2026-10-30 [공식 FAQ](https://openapi.tossinvest.com/openapi-docs/faq.md)를 다시 확인했다. 기존 client/DB advisory lock을 유지하고 소유 worker의 broker 객체를 재사용한다. 토큰을 API·브라우저·파일·DB에 전달하거나 저장하지 않는다.

`market:observe` 또는 `paper:market`에 **`--share-dashboard`**를 명시하면 같은 broker의 인증·단일 갱신·rate limiter를 웹 계좌 조회에도 사용한다. 기본은 비활성이며 합성 관측과 Paper 정지 명령에는 허용하지 않는다. 이 옵션은 Paper 재개가 아니다.

```bash
corepack pnpm market:observe --symbols=KR:005930 --samples=60 --interval-seconds=60 --regular-only --share-dashboard
```

관측은 기존 시장 데이터만 평가·기록한다. 공유를 켰을 때는 로그인한 웹의 새로고침 요청을 처리하기 위해 같은 프로세스가 계좌·보유분·매수 가능 금액도 읽을 수 있다. 계좌 정보는 관측 리포트에 넣지 않는다. 모의 원장·의도·예약·체결도 변경하지 않는다.

owner가 broker 잠금을 얻고 로컬 Unix socket을 연다. API의 기존 조회 child worker는 공유 연결을 먼저 시도한다. 허용 요청은 종목 목록을 포함한 **대시보드 snapshot 조회 하나뿐**이다. 임의 endpoint·계좌 선택·토큰·주문 명령은 없다. 기존 수집/DTO 변환 함수가 계좌 식별자와 원본 응답을 제거한 공개 DTO만 반환한다. API의 인증·localhost 경계와 메모리 cache를 유지한다.

owner가 없거나 stale socket 연결이 거부되면 기존 단독 조회/DB 잠금 경로를 사용한다. 잘못된 응답·권한·timeout·busy는 단독 토큰 재발급으로 우회하지 않는다. 공유하지 않는 이전 버전 관측이 잠금을 보유하면 기존 BROKER_LEASE_BUSY가 유지된다.

## 수명과 제한

조회 취소는 해당 응답을 폐기하고 다음 수집 단계를 막는다. owner의 전역 transport를 취소하지 않는다. 진행 중 broker 작업은 기존 timeout/재시도 범위에서 정리될 수 있다. owner 종료·관측 timeout·잠금 상실은 transport와 공유 연결을 함께 취소한다. 진행 중 source/공유 요청이 정리된 뒤 DB 잠금을 해제한다.

공유 snapshot은 한 번에 하나이며 추가 요청은 RATE_LIMITED로 거부한다. 연결 최대 8개, 요청 4KiB/응답 8MiB, 요청 수신 5초/조회 110초/client 전체 120초/응답 전송 유휴 5초를 상한으로 둔다. 공유 조회는 관측과 호출 제한을 나눠 쓰므로 지연될 수 있다. 관측 신선도/timeout 정책을 완화하지 않는다.

경로는 `/tmp/hth-dashboard-<uid>/<scope-hash>.sock`이다. client ID/secret·동일 DB URL·봉 주기로 scope를 구분한다. 디렉터리 0700/socket 0600과 OS 소유자를 검사하며 심볼릭 링크·기존 파일을 덮어쓰지 않는다. hash는 연결 범위 구분용이며 토큰이 아니다. 정상 종료는 자신의 socket을 제거한다. 강제 종료로 남은 socket은 owner 종료와 잠금 상태를 확인한 뒤 운영자가 정리해야 하며 불명확한 socket을 자동 교체하지 않는다.

## 배포와 적용

새 TCP 포트·daemon·Redis·DB migration은 없다. 같은 서버의 같은 OS 사용자와 파일 시스템에서 동작한다. Unix socket이 없는 Windows는 현재 대상이 아니다. Docker 컨테이너를 분리하면 동일 UID와 socket 디렉터리의 비공개 공유 volume이 필요하다. 서버 한 대라는 이유만으로 컨테이너의 `/tmp`나 프로세스 메모리가 공유되지는 않는다. 여러 호스트의 공통 broker gateway는 후속 설계이며 이번 작업에서 배포는 변경하지 않는다.

실행 중인 기존 관측에는 새 코드가 적용되지 않는다. 종료 후 새 실행에 옵션을 지정한다. 이미 실행된 예약 대기 프로세스도 기존 코드를 로드했을 수 있으므로 옵션을 바꾸려면 기존 대기를 정상 취소하고 별도 재시도 기록으로 다시 실행한다. 조회로 예약·재시작을 수행하지 않는다.

## 검증

가짜 broker로 token 재사용, 동시 만료 시 갱신 한 번, 취소 격리, 추가 조회 제한, owner 종료/drain·재시작, 원문 오류 차단, 잘못된 명령/응답, 비공개 DTO, 권한·심볼릭 링크·scope 분리를 검증한다. Paper runtime은 공유 요청 정리 후 잠금 해제를 확인한다. 일반 테스트는 실제 토스 API를 호출하지 않는다.

전체 363개 테스트와 타입·린트·빌드 검사가 통과했다. 기존 관측 종료 후 수동 실연결 검증에서 공유 모드 관측이 DB broker 잠금을 보유한 전후로 웹 계좌 새로고침이 성공한 것을 확인했다. 관측은 6회/오류 0으로 완료됐고 종료 뒤 잠금을 다시 획득·해제할 수 있었다. 실행 ID는 `51e426ab-5150-4931-80b1-d81c23716c12`다. 금액·계좌·token은 로그에 출력하지 않았고 Paper 정지를 유지했다. 이는 공유 기능의 짧은 연결 검증이며 1시간 운용 검증은 아니다.
