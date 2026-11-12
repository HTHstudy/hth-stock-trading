# 합성 주문 대사의 유한 실행·중단·재연결

2026-11-12 [저장된 대사 기준](ORDER_REVIEW_STORE.md)에 [worker의 단일 사용 세션](../apps/worker/src/synthetic-order-review.ts)을 추가했다. 가짜 관측을 순서대로 처리하고 중단 뒤 기존 기준/요청을 확인하는 내부 검증 도구다. 실제 주문·계좌·Paper 현금/보유분/원가를 변경하지 않는다.

## 범위와 입력

createSyntheticOrderReviewSession은 저장소의 read/record 포트와 가짜 source의 next/close만 받는다. 기본 worker main·HTTP·CLI·스케줄러·broker adapter에 연결하지 않으며 새 라이브러리·설정·마이그레이션은 없다. source는 테스트가 직접 만든 가짜 관측만 제공한다. synthetic-fixture 라벨은 외부 제공자 진위나 계좌 소유권을 인증하지 않는다.

run 설정은 strict source=synthetic-fixture·stream UUID·maxOperations=1..60이다. 기본 실행/자동 초기화는 없다. 유효한 run 하나가 세션을 소비하며 동시 호출·완료 후 재사용은 고정 오류로 거부한다. 잘못된 설정은 I/O/소비 없이 거부하고 source 소유권도 호출자에게 남긴다. 유효한 run은 성공/실패/사전 취소와 관계없이 close를 정확히 한 번 호출한다.

source.next에는 AbortSignal을 전달한다. 반환값은 null 또는 저장소의 **전체 원래 요청**이다. 명령의 stream·operation UUID·기대 version/hash·관측은 strict 검증하며 stream이 설정과 달라지면 저장 전에 멈춘다. 관측 생성은 기존 toOrderObservation을 재사용한다. null 비용을 0으로 고치는 기능은 없다.

## 실행과 중단

1. 저장 기준과 이력을 읽는다. 이미 quarantined이면 source를 읽지 않고 종료한다.
2. source.next를 하나씩 기다리고 입력을 검증한다. 동시 next/record는 없다.
3. 원래 요청의 ID/기대 기준을 바꾸지 않고 record를 한 번 호출한다.
4. receipt가 과거 replay일 수도 있으므로 read로 **현재** 기준을 다시 확인한다. 과거 receipt의 version을 현재 기준으로 사용하지 않는다.
5. 충돌·보류·오류·취소·횟수 상한에서 종료한다. 재시도·새 요청 ID 생성·기대 기준 재작성·보류 해제는 하지 않는다.
6. 진행 중 next/record/read가 끝난 뒤 source.close를 기다린다. 정리 실패는 정상 완료로 반환하지 않는다.

source 대기 중 취소되면 반환된 명령을 기록하지 않는다. record 중 취소되면 이미 진행 중인 DB 작업과 기준 확인을 마친 뒤 종료하며, 커밋을 취소되었다는 이유로 되돌리지 않는다. source가 취소를 무시하거나 영원히 끝나지 않는 경우까지 강제 종료/시간 제한을 제공하는 도구는 아니다. OS 프로세스 종료·네트워크 장애·실제 계좌 재개 보장을 뜻하지 않는다.

## 결과와 불확실한 응답

결과에는 고정 outcome/reason과 attempted·committed·replayed 수, checkpointConfirmed·recordOutcomeUncertain·cleanupSucceeded 및 false 권한 플래그만 담는다. ID·관측·원본 오류·요청·계좌 자료는 반환하거나 로그에 남기지 않는다.

- committed는 새 **대사 receipt**를 받은 횟수다. conflict/review-held도 포함하며 체결 수·거래 성공·원장 적용 수가 아니다.
- replayed는 기존 receipt를 돌려받은 횟수다. 과거 delta를 다시 신규 체결로 집계하지 않는다.
- completed/source-exhausted는 입력이 끝났다는 뜻이다. 주문 체결 완료·실제 대사 완료·수익성·실거래 승인이 아니다.
- limit-reached는 명시된 작업 수까지만 처리한 상태다. source의 나머지 입력이나 주문 상태가 완료됐다고 추정하지 않는다.
- checkpointConfirmed는 마지막 조회 성공 여부이며 그 이후 외부 변경이 없다는 증거는 아니다. 조회 실패를 이전 checkpoint로 대체하지 않는다.
- record 오류는 커밋 여부가 불확실할 수 있어 recordOutcomeUncertain=true로 남긴다. committed=0이어도 미커밋이라고 단정하지 않는다. 정리 실패가 겹쳐도 이 불확실 플래그를 보존한다.

호출자가 원래 요청 전체를 보관해야 불확실한 응답을 별도 세션에서 명시적으로 확인할 수 있다. 이 도구는 파일에 요청을 저장하거나 자동 복구 요청을 생성하지 않는다. 요청을 잃었을 때 최신 기준으로 과거 요청을 추정 복원하지 않는다. 후속 신규 요청은 현재 read 결과를 바탕으로 호출자가 별도 ID로 구성한다. 이 절차는 실제 주문 재전송/재개 권한을 주지 않는다.

모든 결과의 ledgerApplied/canApplyToLedger/ownershipVerified/executionEnabled/canResend/canResume는 false다. 세션 생성/재생성으로 저장소의 영구 중복 키·보류 상태·이력 검사를 초기화하지 않는다.

## 검증

단위 테스트 16개는 잘못된 설정/명령·단일 사용·횟수 상한·사전/조회 중/저장 중 취소·조회/저장/정리 실패·오류 원문 비노출과 권한 플래그를 검사한다.

새 통합 테스트 5개는 전용 localhost 테스트 DB에서 다음을 확인한다.

- 2주 부분 체결 후 취소 신호로 세션을 닫고 DB pool을 닫는다. 다른 pool/세션에서 원래 요청 replay·추가 1주·추가 2주·늦은 수수료 1을 연결한다. 저장 이력은 4개, 최종 누적 체결은 5주/500달러이며 replay는 새 이력이 아니다.
- 실제 DB 커밋 후 응답 실패를 주입하고 자동 재시도 없이 종료한다. 별도 세션의 동일 요청 확인은 replay만 반환한다.
- unknown 관측은 보류를 유지하며 새 세션도 source를 읽지 않는다.
- 오래된 기대 기준은 conflict를 보존하고 새 기준으로 자동 고쳐 제출하지 않는다.
- 가짜 취소 완료 상태는 앞선 2주를 보존하고 이후 누적량 증가를 보류한다. 취소 API를 호출하지 않는다.

이는 같은 테스트 프로세스 안의 세션/DB pool 재생성 검증이다. 실제 OS 프로세스 crash·증권사 접속·주문/취소·실자산·Paper 재개 검증과 구분한다. 기존 worker 변환 통합 2개를 포함한 관련 23개 테스트가 통과했다.

다음 범위는 실제 원장 적용에 앞선 주문 의도/소유권 바인딩 설계다. 이 합성 저장소/세션을 실제 계좌로 이름만 바꿔 사용하지 않으며, 계좌 잠금·영구 적용 키·잔고/원가·정지 제어를 함께 다뤄야 한다.

최종 로컬 `verify:ci`는 이번 작업의 일회용 전용 DB에서 **148파일·1,488개 테스트**를 통과했다(테스트 구간 72.56초). 포맷·린트·타입·전체 빌드와 두 Compose 설정 검사도 통과했다. 원격 Actions 결과가 아니며 사용자 DB 마이그레이션/배포는 실행하지 않았다.
