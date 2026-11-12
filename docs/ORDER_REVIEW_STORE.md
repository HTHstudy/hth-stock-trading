# 합성 주문 대사의 저장 기준·멱등 기록

2026-11-12 [누적 snapshot 비교](ORDER_RECONCILIATION.md)를 저장된 기준과 연결했다. 같은 작업의 재처리와 동시 호출에서 대사 결과가 중복 기록되지 않고, 검토가 필요한 관측이 이후 정상 값에 가려지지 않도록 한다. 현재는 **가짜 source 전용 대사 판정 저장소**다. 실제 주문·계좌·현금/보유량/원가·Paper 원장은 변경하지 않는다.

## 구성과 사용 경계

- 공통 order-reconciliation-v1 결과 계약을 분리했다. 기존 순수 함수의 판정/Decimal 산술과 false 권한 플래그는 그대로다.
- [저장소](../packages/database/src/order-review.ts)는 `@hth/database/testing`의 createSyntheticOrderReviewStore로만 공개한다. 기본 createDatabase 반환 서비스·worker main·HTTP/CLI에는 연결하지 않는다.
- factory는 localhost/127.0.0.1·hth_readonly_test·hth_test와 실제 pool URL 일치를 검사하고, 각 트랜잭션에서 실제 DB/사용자를 다시 확인한다. 생성/기록 명령은 source=synthetic-fixture를 명시해야 한다. 실제 broker source를 선택하는 옵션은 없다.
- 이 source 라벨/범위 hash는 제공자 진위나 계좌 소유권 인증이 아니다. 지금은 직접 만든 가짜 입력만 사용한다. 운영 source로 바꾸거나 기존 계좌를 연결하는 기능은 구현하지 않았다.

[마이그레이션 0007](../packages/database/migrations/0007_synthetic_order_review.sql)은 다음 두 테이블만 추가한다. 기존 계좌/Paper 테이블·값은 수정하지 않는다. 기본 부팅/조회/factory가 마이그레이션을 실행하지 않으며 이번 검증은 새 전용 테스트 DB에만 적용했다. 사용자 DB의 db:migrate는 실행하지 않았다.

| 테이블               | 보관 내용                                                                                                                                      |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| order_review_streams | 합성 source·고정 scope/reference hash·불변 최초 관측·마지막 비교 기준/hash·version·ready/quarantined·이력 수/마지막 receipt hash·상태 checksum |
| order_review_events  | stream/operation ID 기본 키·고유 sequence·변경 없는 요청/hash·판정 receipt/hash                                                                |

금액은 공통 계약으로 검증한 십진 문자열을 JSON에 보존한다. 새 테이블은 실제 계좌와 FK를 맺지 않고 수량/현금/원가 원장을 만들지 않는다. 원본 관측/요청은 서버 내부 비공개 자료다. 조회 결과를 그대로 브라우저 DTO·로그로 내보내지 않는다.

## 초기 기준

initialize는 새 UUID와 명시적 관측만 받는다. pending·0 체결량·**알려진 0 체결금액/수수료/세금**·미체결 시각/평균가·지원되는 수량 기반 정의를 요구한다. null을 0으로 바꾸거나 처음 조회한 기존 체결을 기초 잔고로 소급 저장하지 않는다. worker 변환기의 provider null 보존도 끝까지 검사한다.

동일 stream UUID·같은 최초 관측의 재초기화는 현재 상태를 읽어 반환하며 version·기준·보류 상태를 초기화하지 않는다. 최초 관측을 바꾸면 거부한다. 같은 scope/reference에 새 UUID를 발급해 다시 시작하는 것도 고유 키로 거부한다. scope는 신뢰된 호출자가 고정해야 하며 다른 scope로 가장한 재생성을 이 라벨만으로 방어한다고 주장하지 않는다. reset/delete/resume/보류 해제 메서드는 없다.

## 기록과 재처리

record 입력은 operation UUID·기대 version/관측 hash·새 관측·synthetic-fixture다. operation ID의 멱등 범위는 stream이며 receipt도 그 stream에 고정한다. stream 행 잠금 아래 현재 기준/이력을 검증하고, 순수 함수로 비교한 결과와 기준 변경을 **한 트랜잭션**에서 기록한다.

| 상황                                  | 기록 결과와 기준                                                                        |
| ------------------------------------- | --------------------------------------------------------------------------------------- |
| 새롭고 검증된 비교                    | checkpoint-advanced. version+1과 새 관측/hash를 저장. 판정은 여전히 ledgerApplied=false |
| 정확히 같은 관측, 새로운 작업 ID      | unchanged receipt만 추가. 기준/version 그대로                                           |
| 값은 같고 시각/표현만 새로운 관측     | 경제적 delta=null인 unchanged 판정을 보관하고 관측 watermark/version만 진행             |
| 같은 operation ID·같은 요청 재처리    | 저장 receipt를 replayed=true로 반환. 새 이벤트/기준 변경 없음                           |
| 같은 operation ID·다른 요청/기대 버전 | OPERATION_REUSED. 기존 요청/결과를 덮어쓰지 않음                                        |
| 기대 version 또는 관측 hash 충돌      | conflict receipt를 영구 기록. 기준/version은 그대로. 그 작업 ID를 고쳐 재사용할 수 없음 |
| blocked/review-required               | review-held. 기존 관측/hash 유지, 제어 version+1·quarantined와 원래 판정을 함께 커밋    |
| 이미 quarantined                      | held. 이후 정상 관측도 기준을 진행시키지 않음. 기존 사건/원인을 삭제하지 않음           |

같은 ID의 동시 요청은 한 receipt만 생성하고 나머지는 그 결과를 재사용한다. 다른 ID가 같은 기준으로 경쟁하면 하나만 진행하고 다른 하나는 conflict다. 코드에 자동 재시도는 없다. 새 작업은 호출자가 현재 기준을 다시 읽고 별도 ID로 명시적으로 제출해야 한다.

응답은 `{replayed, receipt}`다. receipt의 version/outcome은 **기록 당시** 결과다. 재시작 후 옛 성공 응답을 돌려받았다고 현재 기준이 옛 version으로 돌아간 것은 아니며, 다음 요청에는 read로 받은 현재 기준을 사용한다. receipt가 재사용됐을 때 그 delta를 다시 원장에 적용하지 않는다. 모든 receipt의 ledgerApplied/canApplyToLedger/ownershipVerified/executionEnabled/canResend/canResume는 false다.

## 이력 검증과 자원 상한

요청·receipt의 schema/hash, sequence와 이전 receipt hash, 기준 hash/version의 연속성, 보류 상태를 현재 stream의 이력 수/마지막 hash와 대조한다. read/재초기화/새 기록/재처리 모두 이 검사를 한다. 과거 receipt의 자기 checksum을 다시 계산해도 뒤 연결이 달라지면 실패한다. 이벤트 삭제·추가·순서/현재 기준 변조도 진행하지 않고 INTEGRITY_FAILED로 남긴다.

합성 스트림은 최대 512개 receipt다. 읽기는 최대 513건만 가져와 초과를 감지하고, 가득 찬 상태에서는 새 기록을 거부한다. 기존 동일 작업의 재처리는 가능하다. 기록을 지우거나 새 UUID로 제한을 우회하지 않는다. 이 제한은 오프라인 검증 범위이며 상시 실거래용 무한 이력 저장 모델이 아니다.

checksum/연결은 변경 탐지이며 DB 관리자의 악의적 전체 재작성에 대한 인증은 아니다. DB 접근과 source/scope의 신뢰 경계, 실제 계좌의 소유권은 이 저장소가 증명하지 않는다. 과거 판정을 새 알고리즘으로 몰래 다시 평가/수정하지 않는다.

## 실패·원자성·남은 작업

기준 갱신 후 이벤트 저장에 실패하면 트랜잭션 전체를 rollback한다. 예상하지 못한 SQL/저장 오류는 고정 TRANSACTION_FAILED로 바꾸고 원본 query/params/detail을 출력하지 않는다. 잘못된 입력·없는 스트림·무결성 오류 등은 쓰기를 시작/완료하지 않으며 이 실패를 모두 receipt가 남은 것으로 표현하지 않는다.

통합 테스트의 저장 실패는 실제 트랜잭션 안에서 insert를 실패시키는 주입으로 검증했다. 다른 병렬 테스트에 영향을 줄 공용 테이블 trigger/관리 권한 변경은 사용하지 않는다. 연결 pool 재생성 후 receipt 재사용도 확인하며 이를 서버 전원 장애/분산 exactly-once/실제 증권사 장애 검증으로 확대하지 않는다.

다음 구현은 이 저장 경로를 바탕으로 주문 생명주기·중단/재시작 정책을 가짜 source에서 검증하는 것이다. 실제 원장 적용에는 계좌/의도/주문 바인딩·잔고/소유권·가격/비용 기준·정지 epoch·계좌 행 잠금과 고유 적용 키를 함께 설계해야 한다. 현행 Paper 원장/예약 차단과 실제 주문 구현 금지 범위는 유지한다.

## 검증 범위

DB 없는 입력/주소/source/0 기준 검사와 기존 순수 대사 회귀, PostgreSQL의 동시 처리·CAS/영구 중복 키·보류 후 기준 보존·이력 오염·저장 실패 rollback·pool 재생성·KRW·worker 가짜 source 연결을 검사한다. 실제 broker/키·계좌·관측/재개·사용자 마이그레이션은 실행하지 않았다. 새 라이브러리·서비스·실행 옵션은 없다.

최종 로컬 `verify:ci`는 새 일회용 전용 DB에서 **146파일·1,467개 테스트**를 통과했다(테스트 구간 76.74초). 포맷·린트·타입·전체 빌드와 두 Compose 설정 검사도 통과했다. 추가한 검사는 DB 없는 단위 13개와 DB 통합 20개이며, 원격 Actions 결과나 실제 증권사 연결 검증은 아니다.
