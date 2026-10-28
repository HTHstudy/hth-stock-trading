# Paper 주문 의도·예약·체결 원장

## 현재 범위

`createDatabase(url).paper`는 Paper 전용 계좌·전략·주문 의도·예약·감사 이력을 제공한다. 실제 증권사 계좌를 가져오거나 주문 API를 호출하지 않는다. 현재 범위는 **의도 선기록·원자적 예약·내부 모의 체결·부분 체결·중단**이다. [별도 Paper worker](PAPER_WORKER.md)는 합성 데이터로 연결했으며 실제 시세는 후속이다. [로컬 합성 Paper 조회·정지 API/화면](PAPER_DASHBOARD.md)은 별도 DTO로 연결했다. 체결 조건·비용·소유권·원가 계산은 [Paper 체결 모델](PAPER_FILLS.md)을 따른다. 반환값의 `executionEnabled`는 항상 false다.

마이그레이션 `0002_wandering_nehzno.sql`과 `0003_silent_harpoon.sql`을 생성했으며 전용 임시 DB에만 적용해 검증했다. 사용자 DB나 운영 환경에는 자동 적용하지 않았다. 기존 읽기 전용 대시보드와 조회 명령은 새 Paper 테이블을 사용하지 않는다.

## 저장 구조와 의존성

| 테이블              | 책임                                                                                |
| ------------------- | ----------------------------------------------------------------------------------- |
| paper_accounts      | Paper 모드, 계좌 version, 정지/epoch, 한도, 잔고·소유권·평가 snapshot, worker lease |
| paper_strategies    | 계좌별 전략 ID·버전과 활성화                                                        |
| paper_order_intents | 불변 요청·신호·hash, 영구 dedupe key, 상태/version, 리스크 결과와 거부 사유         |
| paper_reservations  | 주문별 현금/수량 예약, 평가 단가·비용 가정·유효시간과 해제 여부                     |
| paper_events        | 의도 생성·충돌·리스크 거부·예약·중단·정지·복구 감사 이력                            |
| paper_fills         | 불변 체결 키·수량·대금·비용·실현 손익·quote 시각                                    |
| paper_cost_basis    | 계좌·시장/종목·전략별 남은 수량과 비용 포함 원가                                    |

개인용 MVP에서는 현금·포지션·소유권을 계좌 행의 검증된 JSON aggregate로 보관하고, 활성 예약은 별도 테이블에서 합성한다. snapshot 안에 예약 사본을 저장하지 않는다. 모든 관련 변경은 같은 계좌 행의 `FOR UPDATE` 잠금을 먼저 획득한다. 여러 통화·전략의 동시 요청도 이 잠금을 공유한다. 기존 시장 데이터 테이블의 잔고나 실제 계좌 snapshot과 섞지 않는다.

DB repository가 트랜잭션 안에서 `@hth/trading`의 순수 리스크 검증을 호출한다. trading은 DB·broker에 의존하지 않으며 네트워크 I/O도 하지 않는다. Zod는 이미 사용하던 버전을 DB 입력 경계에도 명시적으로 선언했다. 새 외부 라이브러리 종류는 추가하지 않았다. 예약 numeric 컬럼은 precision/scale을 강제로 줄이지 않아 입력이나 계산 결과를 암묵적으로 반올림하지 않는다.

## 초기화·소유권·복구

`createAccount`는 한 번만 자원을 생성한다. 같은 ID의 재호출로 잔고를 덮어쓰거나 초기 자금을 추가하지 않는다. 초기 포지션은 전량 수동 소유여야 하며 자동 소유분을 넣으면 거부한다. 자동 소유권과 원가는 내부 Paper 매수 체결에서만 생성한다. 통합 테스트의 과거 자동 보유 fixture만 테스트 DB에 직접 주입해 매도 예약을 검증한다.

생성 시 stopped=true, limits=null, reconciled=false다. `configureLimits`·`configureStrategy`는 expected version을 검사하고 정지 상태와 새 epoch를 기록한다. 한도·전략 변경이 기존 승인을 조용히 유지하지 않는다. `stop`은 최신 계좌 행을 잠그고 정지/epoch를 영속화한다. 이미 확보한 예약과 기존 보유분은 그대로 두며 매도나 실제 주문 취소를 실행하지 않는다.

`acquireLease`는 DB 시각으로 만료 여부를 판단하고 임의 token을 발급한다. 새 소유권을 얻으면 정지·새 epoch·복구 필요 상태로 전환한다. `renewLease`는 현재 token과 만료를 검사한다. 호출자가 `workerOwned=true`를 전달해 우회할 수 없다. token은 내부 worker용이며 로그나 공개 응답에 출력하면 안 된다.

복구 순서는 `readOpenIntents`로 현재 미완료 의도를 확인 → 현재 단계의 미전송 의도를 `abort` → `reconcile` → 명시적 `resume`이다. reconcile은 동일 lease·expected version·신선한 관측과 `PAPER_RECONCILED` 확인을 요구한다. 미완료 의도가 남으면 거부한다. mark와 일일 손익만 갱신하며 현금·수량·소유권은 바꾸지 않는다. resume도 복구·한도·lease·미완료 의도를 다시 확인한다. 상시 실행기는 acquireLease → recoverLease → observe → 명시적 resume 순서로 복구한다. recoverLease는 현재 token/epoch와 정지 상태를 요구하고 열린 의도 잔량을 원자적으로 중단한다.

현재 reconcile은 복구용이며 활성 의도를 유지한 채 주기적으로 평가 정보를 갱신하는 메서드는 아니다. 체결은 잔고·비용·소유권을 원자적으로 반영한다. 새 observe는 활성 예약을 유지하며 모든 보유분의 평가/일일 손익을 갱신한다. lease 인수 자체는 예약을 해제하지 않으며, 같은 token/epoch의 recoverLease 또는 releaseLease만 잔량을 정리한다. 이전 worker는 새 소유자의 예약을 정리하지 못한다.

## 기록과 영구 중복 방지

스키마 검증을 통과한 후보는 `recordIntent({ candidate, signal })`로 먼저 **별도 트랜잭션을 커밋**한다. 이후 `reserve`가 실패하거나 롤백되어도 원래 의도는 남는다.

신호 키는 계좌 namespace 안에서 전략 ID·전략 버전·시장/종목·매수/매도·봉 시각·interval·adjusted·source의 hash로 만든다. `intentId`와 신호 키 모두 영구 unique다. 봉 시각은 UTC, 지정가는 십진 표기만 정규화한다. 요청 경제 내용과 신호의 hash를 별도로 보관한다.

같은 신호·같은 내용이면 다른 intentId나 `1000.00` 표기로 재요청해도 원래 의도를 반환한다. 같은 키에 수량·가격 등 다른 내용을 보내면 `PAPER_INTENT_CONFLICT`와 감사 이력을 남긴다. 거부·중단된 의도도 새 ID로 다시 살리지 않는다. 동일한 종료 봉의 일시적 실패에 대한 자동 재평가는 제공하지 않는다.

DB 응답이 불확실하면 먼저 기존 ID/신호 키로 상태를 조회하거나 동일 요청을 재조회한다. 새 키를 만들어 주문을 새로 생성하지 않는다. DB 자체 장애로 실패 이력을 커밋할 수 없을 때도 외부 주문은 발생하지 않으며, 먼저 커밋된 의도와 unique key가 복구 근거다.

## 원자적 예약

`reserve(accountId, intentId, leaseToken, evidence)`의 evidence는 quote·시장 데이터·수집 정상/미확인 주문 상태만 받는다. 외부에서 snapshot·limits·control·전략 활성·dedupe 결과를 주입할 수 없다.

1. 계좌 행을 잠근 뒤 DB `clock_timestamp()`의 epoch milliseconds를 읽는다. 잠금 대기 전 호출자 시각을 기준으로 신선도를 판정하지 않는다.
2. 현재 계좌 상태와 활성 예약에서 snapshot을 만들고 lease·전략 버전/활성·정지 epoch를 DB에서 읽는다.
3. 현재 종료된 최신 봉이 기록한 신호의 시각·interval·adjusted·source와 같은지 확인한다. 다음 봉이 생겼거나 전략 버전이 달라졌으면 `SIGNAL_NOT_CURRENT`로 거부한다. 전략 로직 자체의 재실행은 하지 않으므로 신호 생산자는 신뢰된 서버 전략 엔진이어야 한다.
4. [Paper 리스크 정책](PAPER_RISK.md)을 최신 상태로 재평가한다. 자원을 확보할 수 없으면 RISK_REJECTED와 사유를 기록한다.
5. 예약·READY 상태·account version 증가·감사 이력을 같은 트랜잭션으로 저장한다. 예약 도중 만료되면 ABORTED로 남기고 활성 자원은 해제한다.

매수 예약은 `max(지정가, 현재 quote)` 평가액과 비용을 모두 확보한다. 이 평가 단가를 별도로 보관하므로 다음 요청이 예약을 재구성할 때 원래 지정가만 보고 적게 차감하지 않는다. 지정가가 quote보다 낮아도 과소 예약하지 않는다. 매도는 자기 전략 수량과 전체 매도 가능 수량의 미예약 잔량을 각각 검사한다. 매도 예정 대금을 선사용하지 않는다.

유효시간은 리스크 데이터의 만료와 worker lease 중 빠른 시각이다. lease 갱신이 기존 예약의 유효시간을 연장하지 않는다. `READY`는 자원이 예약되었다는 기록이며 체결 명령이나 주문 전송 토큰이 아니다. 저장된 decision은 **예약 직전 snapshot version의 감사 자료**이고, 예약 자체가 version을 증가시키므로 최신 snapshot과 그대로 재사용하지 않는다. 다음 실행 단계는 자기 예약·현재 lease/epoch·기한과 실제 체결 금액/비용을 별도로 검증해야 한다.

## 상태와 DB 보호 장치

```text
INTENT_RECORDED → READY | RISK_REJECTED | ABORTED
READY → PARTIALLY_FILLED | FILLED | ABORTED
PARTIALLY_FILLED → PARTIALLY_FILLED | FILLED | ABORTED
```

RISK_REJECTED/ABORTED/FILLED는 종료 상태다. 부분 체결도 추가 부분 체결·완료·잔량 중단으로 전이할 수 있다. abort는 미체결 잔량의 예약만 해제하고 이미 반영한 체결·현금·소유권·원가를 보존한다. SUBMITTING·OPEN·UNKNOWN과 외부 주문 취소는 구현하지 않는다.

SQL 트리거는 요청·신호·hash 변경과 잘못된 상태/version 전이를 거부한다. 지연 제약 트리거로 커밋 시 READY와 활성 예약이 서로 일치해야 한다. 예약만 만들거나 READY의 자원만 해제하는 트랜잭션은 거부한다. 예약 수량·평가액·비용과 매수/매도 자원도 검사한다. 비용 검사는 정수 몫/나머지로 올림하여 극소 비용이 numeric 나눗셈에서 0으로 반올림되지 않도록 한다. 예약은 중단에 따른 해제 또는 확인된 모의 체결에 따른 잔량 감소만 허용한다. 다시 활성화하거나 체결 누적 합계와 다른 자원으로 바꾸지 못한다. 지연 트리거는 의도 누적 수량·대금·비용과 불변 체결 행 합계도 검사한다. 의도·예약의 삭제/truncate와 감사 이력의 update/delete/truncate도 거부한다. DB 관리자 권한 우회나 외부 공증까지 방어하는 경계는 아니다.

모든 SQL 실패는 원본 쿼리·계좌·token을 노출하지 않는 오류 코드로 바꾼다. DB 원장과 risk decision은 내부 데이터이며 공개 API/로그에 그대로 출력하지 않는다. 이 모듈을 호출하는 HTTP endpoint나 사용자 DB 초기화 CLI는 추가하지 않았다.

## 검증과 다음 단계

localhost의 `hth_test` / `hth_readonly_test` 전용 DB만 통합 테스트에 허용한다. 병렬 테스트 파일의 마이그레이션은 별도 advisory lock으로 직렬화한다. 테스트는 가짜 시장 세션·가격만 사용하며 실제 증권사 API를 호출하지 않는다.

독립 DB pool 두 개로 현금/수량 동시 예약, 재요청·내용 충돌, 과거 Paper 소유분/수동 보유 보호, 정지 경합과 새 worker 복구 차단을 검증했다. 테스트 전용 실패 trigger로 예약 트랜잭션 rollback과 원래 의도 보존을, 대기 trigger로 예약 중 lease 만료와 자원 해제를 확인했다. 원본/상태/감사 이력 변경 차단과 신호/데이터 검증도 포함한다.

내부 Paper 체결·부분 체결·체결 멱등키와 비용/잔고/소유권/원가 반영도 구현했다. 상시 worker의 복구·관측 갱신·실행 루프도 합성 데이터로 추가했다. Paper 조회/정지 화면도 합성 테스트 DB로 연결했다. 소유자 인증과 전략 조건/revision·불변 변경 이력도 추가했다. 다음은 실제 시세 source의 Paper 운영 검증이다. 사용자 DB 마이그레이션 적용·계좌 초기 자금·실사용 한도는 별도 검토가 필요하며, 합성 테스트 설정을 실제 운용 설정으로 자동 채택하지 않는다.
