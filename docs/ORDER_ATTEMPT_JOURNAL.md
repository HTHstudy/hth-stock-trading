# 주문 의도·단일 전송 시도의 영속 기록

2026-11-18. [기본 비활성 writer](ORDER_WRITER.md)의 메모리 중복 억제를 넘어 **DB에 먼저 남긴 단일 시도와 재접속 후 재전송 금지**를 검증한다. 출처는 `mock-wire-v1`, 통신은 주입한 가짜 fetch/`.invalid`뿐이다. 운영 전송·실계좌 자원 예약과 금융 적용·실거래 gate는 후속 범위다. 이 저장소를 실제 금융 원장으로 사용하지 않는다.

## 경계와 구조

- `contracts/order-attempt`: 정규화된 제한 주문 profile·불변 의도·내부 미적용 0 합계·접수 결과·명령/이벤트의 strict 계약이다. 외부 Toss DTO를 옮기지 않는다.
- `trading/execution/order-attempt`: 정지·owner/epoch·30초 lease, 의도/단일 시도/결과의 순수 상태 전이다. 전략 엔진이나 브로커/DB에 의존하지 않는다.
- `database/order-attempt`: 계좌별 행 잠금, version/hash CAS, DB 시각, 불변 이벤트와 영구 key를 저장한다. factory는 `@hth/database/testing`에만 공개하며 localhost `hth_readonly_test`/`hth_test`와 실제 pool URL 일치를 검사한다. 각 transaction도 DB/role을 재확인한다. 조회/factory로 마이그레이션을 실행하지 않는다.
- `worker/order-attempt-mock`: 테스트용 조합이다. main·HTTP·CLI·환경변수 실행 경로에 연결하지 않는다. 계좌 문맥은 새 UUID이고 가짜 broker 계좌 `42`만 사용한다. 실계좌 번호를 저장/입력받는 경로가 아니다.

새 의존성은 없다. 기존 Zod·Drizzle·PostgreSQL·내용 hash를 재사용한다. 두 테이블/인덱스/보호 trigger의 `0010_order_attempts.sql`은 새 전용 테스트 DB에서만 적용했다. 기존 Paper·합성 금융 테이블/FK와 분리하며 사용자 DB 마이그레이션/배포는 수행하지 않는다.

## DB 기록과 재구성

`order_attempt_accounts`는 불변 source/account UUID/broker/scopeHash와 현재 version/headHash를 저장한다. `order_attempt_events`는 계좌별 연속 sequence와 불변 operationId/commandHash/이전 hash·DB 시각·strict payload/내용 hash를 저장한다. read는 전체 최대 512이벤트를 재생하고 원래 명령의 CAS hash·순서·시각 비퇴행·키 인덱스와 계좌 head/version을 확인한다. 손상 시 초기화/보정하지 않고 차단한다. 계좌당 의도는 최대 64개다.

client key·intent ID·attempt ID·operation ID는 전역 고유, signal ID는 계좌 내 고유다. 의도당 claim과 시도당 결과도 고유다. 재시작/10분 경과/새 client key로 기존 시도를 대신하지 않는다. SQL trigger는 이벤트 UPDATE/DELETE/TRUNCATE와 계좌 삭제/초기 문맥 변경을 거부한다. DB 관리자 전체 재작성에 대한 변조 방지나 분산 exactly-once의 증명은 아니다.

초기 상태는 정지다. 명시적 mock open만 epoch를 증가시키고 단일 owner의 30초 lease를 만든다. 살아 있는 lease 교체는 거부하고 heartbeat는 같은 owner/epoch·유효한 lease에만 허용한다. pause는 epoch를 증가시키고 owner/lease를 폐기한다. 이전 소유자는 새 claim을 만들지 못한다. 기한은 DB 시각으로 검사하며 임의 호출자 시각을 받지 않는다.

## 의도 → 시도 → 결과

1. 의도에는 고정 strategy/revision·signal·UUID client key·정규화 요청·최대 15분 유효 기한을 저장한다. 내부 `quantity/amount/commission/tax=0`은 **전송 전 미적용 기장 합계**이며 provider가 0 체결/0 비용을 보고했다는 관측이 아니다. 초기 보유분·현금·전략 원가를 주입하지 않는다.
2. owner/epoch·lease·의도 hash/기한·계좌 version/head를 계좌 잠금 안에서 검사해 단일 attempt를 먼저 커밋한다. DB transaction 안에서 HTTP를 호출하지 않는다.
3. 새로운 커밋에만 `mockDispatchClaimed=true`를 반환한다. 같은 operation/명령의 재조회는 과거 이벤트를 반환하고 이 값은 false다. 원문/CAS가 다른 operation 재사용은 충돌이다. 새 operation으로 같은 intent를 다시 claim하지 못한다.
4. 테스트 조합은 커밋 후 제어/기한을 다시 확인하고 가짜 writer를 한 번만 호출한다. 원래 attempt의 client key가 같은 결과만 별도 CAS로 저장한다. `mockWriterInvoked`는 adapter 호출 여부이며 주문 POST/접수 성공을 뜻하지 않는다. 인증 실패는 별도의 not-sent 결과로 저장한다. 응답/오류 원문은 받지 않고 strict 안전 결과만 저장한다.
5. 정지/lease 만료 뒤에도 원래 시도에 연결된 결과는 **근거로만** 저장할 수 있다. 접수는 체결/자산 변화가 아니고 정지 해제나 이전 소유자의 새 전송 권한이 되지 않는다.

pause는 이미 진행 중인 원격 효과의 부재를 보장하지 않는다. 커밋과 fetch 사이의 제어 재확인 뒤에도 경쟁 구간이 남으며, 이 mock 구조를 실제 원격 권한 폐기/운영 gate로 사용하지 않는다.

## 중단·불확실성·재시작

시도 커밋 뒤 프로세스가 끊기거나 결과 저장이 실패하면 `result=null`인 미확인 시도를 보존한다. 이것을 미전송·실패·프로세스 생존/종료로 추정하지 않는다. 명시적 unknown/not-sent 결과도 자동 재전송 허가가 아니다. DB 연결/토큰 관리자를 새로 만들어도 저장된 claim replay는 가짜 인증/POST를 호출하지 않는다. 결과 replay도 근거 조회이며 새 금융 적용이 아니다.

현재 계좌에 시도가 하나라도 있으면 새 의도의 후속 claim도 `REVIEW_REQUIRED`로 막는다. ACK를 포함해 실주문 상세 대사·종료/자원 해제 계약이 없으므로 새 key로 우회하지 못하게 한 제한이다. 전송 한도·의도 수·lease를 풀어 연속 운용하는 기능은 없다.

DB 커밋 응답 자체가 유실되면 호출자는 새 operation을 만들어 보내지 않고 원래 ID로 조회해야 한다. 저장 실패 뒤 자동 retry는 없다. 서버 내부 조회에는 가짜 요청/의도/이력이 포함되므로 웹 DTO/로그에 노출하지 않는다. 모든 결과의 executionEnabled/ownershipVerified/canApplyToLedger/canResend/canResume는 false다.

## 검증과 남은 범위

순수/경계 테스트와 두 DB pool·가짜 broker 통합으로 동시 claim 단일화, 신호/client key 재사용, 재접속 replay, 응답 유실, 결과 저장 실패, claim 저장 rollback, 정지 전후 응답, 이력 불변/손상 차단을 검사한다. 새 pool은 동일 테스트 프로세스 내 재접속이며 실제 OS crash/증권사 장애나 자연 토큰 갱신 검증은 아니다. 마이그레이션은 일회용 전용 테스트 DB만 사용한다.

[전송 계약](ORDER_TRANSPORT_DESIGN.md)의 2단계 중 **전송 의도/attempt 영속화의 mock 검증**을 완료했다. 후속 주문별 기장은 아래 계약을 따르며, 실제 금융 opening·예약·자원/소유권 대사가 남아 있다. 그 다음 운영 gate/조회 복구를 검증하고 별도 제한된 실계좌 실행 승인을 받아야 한다. 현재 코드나 내부 0 기준은 실거래 가능/자산 대사 완료를 뜻하지 않는다.

최종 로컬 전체 검증은 새 전용 테스트 DB에서 기본 병렬 160파일·1,775개 테스트(126.24초), 포맷·린트·타입·빌드·두 Compose 설정을 통과했다. 신규 40개를 포함한다. 최초 timeout/재사용 DB의 잔존 lease 실패와 최종 재검사는 [검증 기록](CI_VALIDATION.md)에 구분했다.

## 첫 누적 체결과 주문별 기장

접수된 시도에 `observe-fill`과 `apply-fill` 이벤트를 추가했다. 전용 테스트 DB의 기존 계좌 잠금·version/hash CAS·불변 이력을 사용한다. `0011_order_attempt_fills.sql`은 기존 기록을 유지하고 이벤트 종류 제약만 확장한다.

관측은 기존 정규화 주문 계약을 사용한다. 저장된 접수 참조·계좌 범위·시장/종목·매수/매도·수량·지정가·당일 조건과 일치해야 한다. 주문 시각은 시도 기록 이후여야 한다. 제한 profile의 대기·부분·전량 상태를 처리하고 모순·정정·비용 누락이 있는 연결된 관측은 검토 대상으로 보존한다.

기장은 관측과 별도로 순서대로 요청한다. 첫 관측이 부분 또는 전량 체결이면 전송 전 저장한 내부 미적용 합계에서 누적 수량·거래 대금·수수료·세금 차이를 계산한다. 다음 관측은 직전 기장 합계에서 차이를 계산한다. 같은 적용 명령을 다시 읽으면 기존 기록을 반환하고 새 명령으로 동일 관측을 중복 기장할 수 없다. 결측값은 보존하며 이후 관측에 값이 들어와도 미적용 순서를 건너뛸 수 없다. 지정가 위반과 수량 증가 없는 금액·비용 정정도 검토로 남는다.

이 단계의 원장은 가짜 주문별 누적 합계와 현금 영향 기록이다. 계좌 잔액·전략 보유분·원가·정산에 연결하려면 별도의 자원 예약과 금융 대사가 필요하다. 운영 게이트와 실거래는 계속 비활성이다. 기존 시도의 DB 재생과 신규 관측/기장은 전용 테스트 저장소에서만 제공한다.
