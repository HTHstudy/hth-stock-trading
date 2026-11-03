# 읽기 전용 토스 토큰 수명 계측

토스 transport 인스턴스가 자기 토큰 발급 시도의 원인·결과·시각만 메모리에 집계한다. 읽기 전용 adapter의 `readTokenLifecycle()`는 복사된 JSON snapshot을 반환하며 토큰 발급·DB·파일·로그·시세 요청을 실행하지 않는다. 전략이나 공통 ReadonlyBroker 포트에는 이 메서드를 추가하지 않는다. 공유 대시보드 IPC와 HTTP에도 계측을 제공하지 않는다.

## 원인과 결과

| trigger      | 의미                                                                           |
| ------------ | ------------------------------------------------------------------------------ |
| initial      | 이 transport에서 아직 토큰을 수용하지 않은 최초/재시도 발급                    |
| expiry       | 기존 클라이언트 갱신 시각에 도달한 발급. 서버 토큰이 이미 만료됐다는 뜻은 아님 |
| unauthorized | 현재 캐시 토큰에 대한 읽기 요청의 401 이후 발급                                |

각 원인에 started/succeeded/failed/cancelled를 집계한다. started는 rate limiter 대기를 포함한 발급 시도이므로 서버가 HTTP를 처리했다는 증거가 아니다. 실패 후 재시도는 기존 원인을 유지하며 동시 대기 요청 여러 개를 별도의 발급으로 세지 않는다. 유효 토큰 재사용, 늦게 도착한 이전 토큰의 401로 현재 토큰을 재사용한 경우에도 추가 발급을 세지 않는다.

succeeded는 성공 HTTP 응답과 토큰 DTO/클라이언트 갱신 여유를 검증한 뒤 로컬 캐시에 수용했다는 뜻이다. 이후 계좌 조회가 또 401로 끝나더라도 토큰 발급 성공 자체를 실패로 바꾸지 않는다. cancelled는 실패와 별도로 세며, 시작 전 취소는 started도 만들지 않는다. 인증 응답 중 취소가 발생하면 늦은 성공을 캐시에 수용하지 않는다. 기존 rate limit·인증 요청 횟수·GET 재시도 예산은 늘리지 않았다.

실패 코드는 허용한 BrokerError 코드 또는 UNKNOWN뿐이다. 토큰/키/Authorization 헤더/계좌/종목/URL/요청 ID/원본 응답/예외는 계측에 넣지 않는다. 코드와 카운터로 broker 상태나 매매 재개를 승인하지 않는다.

## 시각·이력·크기

- 시도 번호와 phase 시각, 성공 시 응답의 expiresInSeconds 및 validityBaseAt/refreshAt/expiresAt만 기록한다. validityBaseAt은 기존 transport가 발급 요청 전에 잡은 보수적인 클라이언트 기준이며 서버의 실제 발급 시각이 아니다.
- refreshAt은 기존 계산 `base + TTL - min(60초, TTL×10%)`, expiresAt은 `base + TTL`이다. TTL을 예시 값으로 고정하지 않는다. 서버의 실제 만료 시각이나 남은 사용 권한을 보증하지 않는다.
- 상세 이벤트는 마지막 128개만 유지한다. 상한을 넘으면 limited=true이고 원인별 전체 집계는 유지한다. 잘린 과거 이벤트를 복원하거나 전체 수명 이력이라고 주장하지 않는다. 메모리는 시도 횟수에 따라 무한 증가하지 않는다.
- inFlight는 현재 transport에서 아직 결과가 없는 발급 시도 수(0 또는 1)다. 프로세스 생존/계좌 worker lease/주문의 처리 상태가 아니다.
- 기록 또는 snapshot 조회 시각이 역행하거나 시각을 표현하지 못하면 clockUnverified=true다. 없는 시각은 null이며 현재 시장 데이터 신선도나 서버 시간 정확도를 추정하지 않는다.
- strict JSON 계약은 비공개 필드·임의 코드·순서/중복/원인 모순·집계/inFlight 모순·시각 검증 주장·TTL 계산 모순을 거부한다. limited 결과에서는 남은 이벤트가 집계의 부분집합인지만 검증할 수 있다.

## 관측 CLI에서 보관

기본은 파일 저장 비활성이다. 새 실제 읽기 전용 관측에서 명시적으로 선택한다. 합성 `--demo`와 조합하면 거부한다.

```bash
# 실행 예시이며 이 기능 개발 중 실제로 시작하지 않았다.
corepack pnpm market:observe --symbols=US:AAPL --samples=60 \
  --interval-seconds=60 --regular-only --token-lifecycle
```

이 옵션은 기존 관측 실행의 동작/범위를 바꾸지 않으며 토큰 갱신을 강제로 일으키지 않는다. 기존 client/DB 잠금·공유 broker·취소/요청 정리·단일 token manager를 그대로 따른다. source 정리와 공유 요청 정리 후, 잠금을 해제하기 전에 소유자가 `token-lifecycle.json`을 기록한다. 기록에 실패하면 정상 완료로 통과시키지 않는다. 기존 관측 terminal/journal 해시 구조는 변경하지 않는다.

파일은 기존 UUID 관측 폴더의 고정 이름으로 생성하며 runId/source/manifestHash/snapshot/content hash를 포함한다. 최대 128KiB, 0600·임시 파일 sync/hard link의 원자적 새 생성이며 기존 파일을 덮어쓰지 않는다. `verifyTokenLifecycleEvidence` 순수 함수가 strict schema·내용 hash·manifest 연결·동일 UUID/source 및 시각 경계를 검사한다. 파일 hash는 작성자 인증/서명이나 원천 데이터 진위의 공증이 아니다. 서버 소유자만 자료를 쓰는 기존 private 환경이 전제다.

파일은 종료 정리 시점에만 만든다. SIGKILL/전원 종료/정리 실패에는 생성되지 않을 수 있다. 파일 없음은 발급 0건이 아니다. inFlight>0이면 미완료 시도가 남았다는 뜻이며, 파일만으로 전체 관측 정상 종료·잠금 해제나 정규장 품질을 입증하지 않는다. 기존 terminal/journal 검증을 별도로 수행한다. clockUnverified/limited도 함께 검토한다.

파일을 만드는 것은 실제 갱신 검증과 다르다. initial만 기록되면 그 실행의 갱신 경로는 미검증이다. 실제 반환 TTL을 고려한 유한 계획에서 expiry 발급·후속 읽기·종료/잠금 정리를 확인해야 한다. 401 재발급을 유효기간 갱신으로 대체하지 않는다. 다른 프로세스/외부 도구의 발급은 이 인스턴스의 집계에 포함되지 않는다.

## 이번 검증 범위

실제 broker를 호출하지 않고 주입한 fetch와 시계로 동시 성공/실패·재사용·TTL 1/120/3600초의 경계·expiry 실패 후 재시도·401 재발급·늦은 401·취소·timeout·상한·복사본 불변성·시각 역행을 검사했다. 가짜 토큰 발급/갱신을 worker 보관 파일까지 연결해 hash/manifest·순서/집계·비공개 필드 거부·권한/덮어쓰기 방지를 확인했다. DB/스키마/원장 변경이나 실제 수명 검증은 없다.

기존 미국 23:35 일회성 실행은 동일 hash의 고정 빌드에서 계속 대기한다. 이번 계측을 적용하려고 취소·교체·재예약하지 않는다. 그 구버전 실행에 새 계측 파일이 없다고 갱신 실패로 판정하지 않으며 사후 추정으로 파일을 만들지 않는다. [다음 장시간 검증](LONG_RUNNING_VALIDATION.md)은 별도 유한 계획으로 진행한다.
