# 합성 주문 연결의 영구 저장

2026-11-13 [연결 검사](ORDER_BINDING_REVIEW.md)를 전용 테스트 DB의 영구 기록과 연결했다. **합성 신원/근거 주장만 저장하는 내부 테스트 capability**다. 실제 계좌/접수 증거를 인증하거나 Paper/실제 금융 원장·주문·예약·재개를 변경하지 않는다.

## 구성과 경계

[createSyntheticOrderBindingStore](../packages/database/src/synthetic-order-binding.ts)는 `@hth/database/testing`에서만 공개한다. 기본 createDatabase 반환 서비스·worker main·합성 실행 세션·HTTP·CLI에 연결하지 않았다. 새 라이브러리/서비스는 없다.

factory는 localhost/127.0.0.1의 hth_readonly_test/hth_test와 실제 pool URL 일치를 검사한다. 각 transaction에서도 current_database/current_user를 확인하고 statement/lock timeout을 고정한다. source와 namespace 환경은 synthetic-fixture만 받는다. 조회/factory가 초기화·마이그레이션을 실행하지 않는다.

[마이그레이션 0008](../packages/database/migrations/0008_synthetic_order_bindings.sql)은 별도 네 테이블과 전용 제약/트리거만 추가한다. 기존 0000~0007과 Paper/order_review 테이블은 수정하지 않는다. 파일 생성과 일회용 테스트 DB 적용만 수행했으며 사용자 DB에는 적용하지 않았다.

| 테이블                     | 내용과 보호                                                                                                                            |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| synthetic_binding_accounts | 영구 UUID·broker/합성 환경/scope·version/count·마지막 receipt hash·상태 hash. 같은 계좌 행 잠금으로 등록/조회/기록을 직렬화            |
| synthetic_binding_intents  | 계좌+intent PK·계좌별 영구 신호 unique·불변 원래 의도/내용 hash·생성 version                                                           |
| synthetic_order_bindings   | 전역 binding UUID, 계좌별 intent/신호/주문 unique, 같은 계좌/intent/전체 의도 hash의 복합 FK, 최초 후보/근거/hash·생성 version·작업 ID |
| synthetic_binding_events   | 계좌+operation PK·계좌별 sequence unique·불변 요청/receipt/hash·해당 계좌 binding 복합 FK·이전 receipt 연결                            |

FK가 참조하는 복합 고유 키는 테이블 생성 시 함께 선언한다. 최초 생성 SQL의 FK/고유 인덱스 순서 문제는 일회용 DB 검사에서 발견해 수정했다. 미커밋/미적용 0008만 다시 생성했으며 공개된 과거 마이그레이션을 고치지 않았다.

의도·연결·event의 UPDATE/DELETE/TRUNCATE와 계좌 삭제/신원 변경·count/version 역행을 SQL에서도 거부한다. 계좌 count/version 일치와 범위도 CHECK로 검사한다. 무결성 hash는 변경 탐지이며 관리자에 의한 전체 재작성 방어·실제 접수 인증이 아니다.

## 명시적 초기화와 의도 선기록

1. initialize는 source·합성 namespace·scope만 받아 빈 계좌를 한 번 생성한다. 같은 값으로 다시 호출하면 현재 검증된 상태를 반환하고 초기화하지 않는다. 같은 계좌의 broker/scope 변경이나 같은 scope의 다른 UUID 등록은 실패한다.
2. recordIntent는 expectedVersion/expectedStateHash와 전체 원래 의도를 받아 별도 transaction으로 커밋한다. 같은 ID/같은 원문은 replay이며 내용 변경·같은 신호의 새 intent UUID는 거부한다.
3. 새로운 의도를 저장하면 version/intentCount가 증가한다. 원문은 UUID 대소문자와 JSON optional undefined를 정규화한 뒤 보존한다. 십진 표기 등 다른 원문으로 기존 의도를 다시 쓰지 않는다. 원래 requestHash/dedupeKey는 합성 주장이고, DB가 계산하는 payloadHash도 원문 checksum일 뿐 실제 소유권이 아니다.

계좌의 version은 intentCount+bindingCount다. 신규 의도나 연결만 증가시키며, 새 실패/충돌 receipt는 version을 유지한다. 다만 모든 새 receipt가 상태 hash를 바꾸므로 **같은 version이라도 낡은 state hash로 새 명령을 실행할 수 없다.**

## 연결 기록과 재조회

record는 operation UUID·expectedVersion/expectedStateHash·합성 evidence를 받는다. evidence는 원래 검사 입력에서 **intent/registry를 제외**한 계약이다. 호출자가 DB 대신 전체 목록/소유 의도를 제출하는 입력은 거부한다.

계좌 행 잠금 후 현재 계좌·의도·연결·이력 전체를 검증한다. 실제 저장된 의도와 완전한 해당 계좌의 연결 목록으로 순수 검사를 실행한다. 누락/다른 계좌/전략 revision·경제 요청 불일치를 호출자에게 맞춰 고치지 않는다.

| 상황                          | 결과                                                                   |
| ----------------------------- | ---------------------------------------------------------------------- |
| 새롭고 일관된 합성 연결       | bound. 연결+receipt+계좌 count/version/head를 같은 transaction에 저장  |
| 같은 binding UUID/내용        | unchanged receipt만 추가. 최초 후보/접수 근거를 덮어쓰지 않음          |
| 순수 검사상 누락/불확실 접수  | unassigned receipt. 연결/소유권은 생성하지 않음                        |
| 순수 검사상 모순/중복         | blocked receipt. 기존 연결은 그대로                                    |
| 낡은 version/state hash       | conflict receipt. 자동 재시도/기대 기준 재작성 없음                    |
| 같은 operation·같은 전체 요청 | replayed=true와 원래 receipt. 최신 version/성공으로 다시 평가하지 않음 |
| 같은 operation·다른 요청      | OPERATION_REUSED. 기존 요청/판정을 수정하지 않음                       |

이미 미배정으로 기록된 의도는 사후 의도 등록을 거부한다. 새 UUID를 사용하더라도 이전 미배정 주문 reference 또는 의도를 다시 연결하려 하면 REVIEW_REQUIRED로 차단한다. uncertain/unattributed를 acceptance로 고쳐 자동 승격하지 않으며, 같은 operation의 원래 결과 조회만 허용한다. 검토 해제/기록 삭제/재개 메서드는 없다.

이 거부와 입력 오류·SQL 오류 등 모든 실패에 receipt가 생긴다고 주장하지 않는다. SQL 오류는 원문/파라미터 없이 고정 TRANSACTION_FAILED로 바꾸며 자동 재시도하지 않는다. 전역 binding UUID 충돌도 전체 transaction이 rollback된다. 응답이 불확실하면 **원래 요청 전체와 같은 operation**으로 상태를 확인하며 새 ID를 생성해 재실행하지 않는다.

## 이력·순서·상한

모든 조회/초기화 재호출/재처리/새 등록에서 다음을 확인한다.

- 계좌 상태 hash와 실제 의도/연결/event 개수 일치.
- 의도/후보/최초 evidence의 strict 계약·내용 hash·계좌·전략/신호·원래 의도 hash 연결.
- 생성 version의 중복/공백 없음. 연결 이전에 해당 의도가 저장됐음.
- receipt의 요청/hash·sequence·이전 hash·version 전이와 연결 생성 사건의 일대일 대응.
- 각 사건 직전 상태 hash를 의도/연결 생성 순서와 당시 감사 head로 복원해, 저장된 CAS 입력과 conflict/비충돌 구분이 맞는지 확인.

계좌마다 최대 256개 의도/연결과 512개 receipt다. 읽기는 초과를 감지하도록 최대 257/513개만 읽고, 부족/초과를 정상 목록으로 자르지 않는다. 한도에서도 기존 정확한 요청 replay는 허용하며 새 등록은 LIMIT로 거부한다. 재초기화나 새 UUID로 같은 scope/신호/주문을 재사용하지 않는다. 운영용 무제한 원장 모델이 아니다.

read는 서버 내부 계좌/검증된 후보 목록과 false 권한 플래그를 반환한다. 계좌 UUID/scope/state hash가 포함되므로 공개 웹 DTO/로그로 사용하지 않는다. 실제 계좌 번호·키·토큰을 입력/저장/출력하지 않는다. receipt의 review.bindingPersisted=false는 **당시 순수 검사 결과**이고, 바깥 bound/unchanged는 합성 DB 레코드 저장/조회만 뜻한다.

모든 결과의 evidenceAuthenticated/financialBaselineEstablished/ledgerApplied/canApplyToLedger/ownershipVerified/executionEnabled/canResend/canResume는 false다. 관측/적용 기준·현금·보유량·원가·실제 주문 전송은 이 테이블에 없다.

## 검증과 다음 범위

DB 없는 경계 검사 10개와 PostgreSQL 통합 24개를 추가했다. 같은/다른 operation 동시 경합·영구 키/CAS·다른 계좌 FK·DB 불변 제약·전역 UUID 충돌·재접속/과거 receipt·최종 갱신 실패 rollback·상태 손상·사후 편입 차단·상한/replay를 검사한다. 기존 Paper 계좌와 합성 대사 스트림의 별도 fixture가 그대로인지도 확인한다.

한도 검사는 직접 만든 합성 행/연결 hash로 구성한 전용 DB fixture를 사용한다. 복구 검사는 같은 테스트 프로세스의 다른 pool/저장소 생성이며 실제 OS crash/증권사 장애나 분산 exactly-once를 검증한 것은 아니다. 테스트는 실제 broker API를 호출하지 않는다.

다음은 설계 순서 3의 **합성 금융 적용 모델**이다. 관측 이력과 적용 기준을 분리하고 영구 적용 키·계좌 잠금 아래 0→2→3→5, 응답 유실/중간 실패, 수동 10주 보존과 타 전략 매도 차단을 검증한다. 이번 저장소가 실계좌용이 되거나 기존 Paper fill을 대신하지 않으며 실제 주문 기능은 계속 미구현/비활성이다.

최종 로컬 `verify:ci`는 새 일회용 localhost 전용 DB에서 **151파일·1,598개 테스트**를 통과했다(테스트 구간 76.10초). 포맷·린트·타입·전체 빌드·두 Compose 설정·문서 링크/diff도 통과했다. 최종 코드를 기본 병렬 설정으로 검사했으며 원격 Actions/실제 계좌 운용 결과와 구분한다. 테스트용 컨테이너는 검사 후 소유 ID로 정리한다.
