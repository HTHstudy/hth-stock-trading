# 이력이 있는 Paper 계좌의 후속 유한 검증

기존 초기 계좌용 검사를 유지하면서 **직접 연결한 이전 실행과 현재 원장이 일치하는 경우에만** 별도 후속 모드를 허용한다. 현재 작업은 구현과 합성 검증이며 실제 계좌 점검·시세·토큰 발급·관측 예약·Paper 재개·실주문을 수행하지 않았다.

## 기본 정책

continuation 인자가 없으면 기존 pristine 검사(초기 현금·보유/주문/체결/예약 없음)를 그대로 사용한다. 후속 모드는 다음 세 인자를 모두 명시해야 하며 일부 누락·잘못된 UUID/hash는 I/O 전에 거부한다.

| 인자                           | 의미                                               |
| ------------------------------ | -------------------------------------------------- |
| `--continue-from=<UUID>`       | 바로 이전 유한 검증 run                            |
| `--continuation-launch=<UUID>` | 그 run을 직접 생성한 소유 프로세스 launch          |
| `--continuation-hash=<SHA256>` | 아래 읽기 전용 검토에서 확인한 전체 증거 묶음 hash |

기존 `--execute`·`--run`·`--resume-authorized`, 새 일정/선행 관측·고정 코드/resources·현재 제어 기대값은 여전히 별도로 필요하다. 후속 인자나 hash만으로 재개하지 않는다. 부모와 같은 run UUID를 재사용하거나 원본 폴더를 덮어쓰지 않는다.

현금·보유분·원가·일일 손실·기존 의도/체결/예약·중복 키를 초기화하지 않는다. 매수만 남은 계좌도 보유분을 정지 상태로 유지한 채 다음 창을 검토할 수 있지만 매도는 기존 전략의 실제 신호와 자기 소유량/리스크 검사를 통과해야 한다. 자동 청산이나 신호 발생 보장이 아니다.

## 서버 소유자의 무접속 검토

빌드는 별도로 끝낸 뒤 프로젝트 루트에서 실행한다. 명령은 .env·DB·계좌·시세·worker를 만들지 않고 기존 파일만 읽는다. 부모 원본이나 새 실행 폴더를 수정하지 않는다.

```bash
node infra/authorized-paper-validation.mjs --market=KR --inspect-continuation \
  --continue-from=<PREVIOUS-RUN-UUID> \
  --continuation-launch=<PREVIOUS-LAUNCH-UUID>
```

출력은 검토 상태·시장·지정 UUID·evidenceHash와 `dbAccessed=false`, `executionEnabled=false`, `canResume=false`다. 현금·종목별 원장·계좌 ID·경로·인수 원문을 출력하지 않는다. 조회는 현재 계좌가 그 상태인지 확인하지 않으며 운용 승인도 아니다. `--continuation-hash`를 함께 주면 바이트 묶음의 동일성도 대조한다. 조회 모드는 실행/재개·다른 점검 모드와 결합하지 않는다.

`paper:validation:owned`는 새 인자를 검증하고 원래 runner 인수에 포함한다. launch의 인수 hash·새 run UUID/nonce 연결과 키/환경 필터링은 유지한다. 조회에 소유 프로세스를 만들 필요는 없다.

## 부모 증거와 허용 범위

서버 고정 `.local-data/paper-validation-runs/<UUID>/`의 request/result/before/after/review와 `.local-data/paper-validation-processes/<UUID>/`의 launch/exit, 총 7개 파일만 읽는다. UUID로 제한한 경로·일반 파일/O_NOFOLLOW·디렉터리 symlink/교체·읽기 전후 파일 identity/크기/시각을 검사한다. checkpoint/review 각각 32MiB, 나머지 각각 64KiB, 전체 64MiB가 상한이다. 잘라 읽은 이력이나 누락 파일을 완료 자료로 보지 않는다.

- strict request/result/checkpoint/review·내용 hash·같은 source/scope/시장·전후 연결과 기록 수/정리를 확인한다.
- 저장한 `review.report.asOf`로 대사를 오프라인 재계산해 이전 report hash와 같은지 확인한다. 과거 원본/판정을 수정하지 않는다.
- 원장/순서·경제 상태·소유권·원가·종료 검사에 failed 또는 미검증이 남으면 차단한다. 외부 변경·복수 lease·동률/늦은 체결의 불확실성을 hash 재계산으로 해소하지 않는다.
- 신호/체결/진단 또는 새 관측이 없어 일부 경로가 미검증인 경우는 별개다. 경제 상태·이력의 검사가 일치하고 단일 lease 획득/해제가 있으며 독립 종료가 확인되면 incomplete 상태를 그대로 둔 채 후속 검토할 수 있다. 체결 검증 완료로 바꾸지 않는다.
- 허용 부모 상태는 completed, completed-with-incomplete-review와 정지/휴장 코드의 execution-ended-early다. 일반 실패·취소·기한 중단·정리 미완료·issues-found는 대상으로 삼지 않는다.
- 소유 launch/exit의 UUID·run·nonce·launch hash·exit hash·정상 종료 코드·시간 순서를 대조한다. signal·forced·clockUnverified는 허용하지 않는다. completed의 exit 0, incomplete/허용 조기 종료의 exit 2를 구분한다.

기존 완료 판정과 손익을 다시 쓰지 않으며 PID 검색·현재 정지·기한 경과로 독립 종료 증거를 대신하지 않는다. 직접 부모의 증거만 검증하고 무제한 과거 체인을 재귀 탐색하지 않는다. 부모 checkpoint에는 그때의 전체 이력과 영구 중복 키가 포함된다. 동일 서버 권한자가 모든 파일/hash를 다시 만드는 행위의 진위를 공증하는 서명은 아니다.

## 현재 계좌와 실행 전 검사

부모 증거는 대기 전, DB 단계 진입 전, 재개 직전에 같은 hash로 다시 읽는다. 파일 변경·소실·hash 불일치는 `PAPER_CONTINUATION_INVALID`로 차단한다. 고정 resources hash도 같아야 해 동일 검증 계획만 이어갈 수 있다.

DB는 기존 localhost 전용 hth_test/hth_readonly_test 경계를 사용한다. 초기 모드와 공통으로 source=toss-readonly·정지·lease 없음·한도·전략/revision·불변 이력·오프라인 준비 영수증·현재 version/epoch/전략/한도 hash를 검사한다. 계좌를 다시 만들거나 준비 계획을 덮어쓰지 않는다.

후속 모드에서는 초기 현금·보유/주문/체결/과거 예약이 0이어야 한다는 다섯 조건을, **부모 after와 현재 체크포인트의 전체 동일성 검사**로 대체한다. 제외하는 필드는 읽은 시각 `asOf`뿐이다. scope(계좌/출처/DB 경계), version/epoch, 현금·손실/거래일·포지션/수동·전략 소유권·원가·의도·체결·예약·이벤트를 모두 고정한다. 정지·lease 없음·진행 의도/활성 예약 없음도 필요하다. 외부 stop 한 번, 동일 값의 한도 재설정, 별도 진단 이력 추가도 기준 변경으로 차단될 수 있다.

기준 이후 단계에는 기존 이력을 그대로 유지하면서 해당 단계의 예상 사건만 추가할 수 있다. 일일 검토의 lease/검토/해제, 정지 1회 관측의 lease/복구/두 관측/진단 1건/해제를 검사한다. 관측 후 before 체크포인트는 다시 전체 동일성을 확인한다. 각 lease 획득과 실제 resume은 계좌 행 잠금 안에서 version과 사건 집합 hash를 함께 대조한다. 버전을 올리지 않는 거부 이력도 중간에 추가되면 차단한다. 재개 직전에는 lease/복구/관측만 추가됐는지 별도로 검사한다.

기준 검사 후 `continuation-evidence.json`에 부모 ID/hash와 baseline 검사 hash만 기록한다. 일일 기준 검토는 기존 carry-negative-pnl-v1으로 별도 수행하며 손실을 재시작으로 지우지 않는다. 이어 정지 실제 시세 1회 관측·전 종목 quote/공식 세션·확정 봉·리스크·재개 직전 체크포인트·CAS를 적용한다. [선행 관측 15분/전체 범위·조기 종료](PAPER_VALIDATION_GUARDS.md)와 최대 60 tick도 유지한다.

새 실행은 자기 before/after·review·독립 exit를 남긴다. 판정과 거래 수는 그 새 구간의 delta로 검토하며 기존 체결을 신규 체결로 세지 않는다. 결과 파일의 intents/fills 총수는 누적이므로 대사의 newIntents/newFills와 구분한다. 조회 HTTP DTO에는 후속 부모 경로나 계좌/원본 증거를 추가하지 않는다.

## 남는 제한

- 전략·한도·계획·revision은 기존 고정값이다. 전략 편집/한도 변경을 수용하는 재승인 또는 원장 복구 모드는 아니다.
- 기존 초기 계좌/이력 제거·새 계좌 생성으로 차단을 우회하지 않는다. 기준이 달라졌다면 원인과 필요한 복구 절차부터 검토한다.
- 시장 상태·현재 가격·체결 가능성·수익성은 파일 조회로 확인하지 않는다. 실제 운영 실행은 별도 명시적 의사가 필요하다.
- production 1주/최대 체결 1주 설정은 그대로다. 합성 테스트의 2주/부분 체결/1·2 이동평균을 운영 계획에 적용하지 않는다.
- 오래된 미해결 예약 a407과 장시간 감독기 차단을 해소하거나 예외로 만들지 않는다. DB/서버 이동으로 scope가 달라지는 경우도 자동 승계하지 않는다.

## 검증

가짜 부모 자료의 정상/실패/강제 종료·연결/시각/hash·불확실한 대사·이력/소유권/손실/원가/CAS 변경, 파일 누락/바이트 변경/symlink·조회 CLI 무접속/무변경·인자 누락/실행 혼합 거부를 검사한다. 기존 wrapper는 가짜 launcher만 사용한다.

전용 새 UUID 합성 DB에서 KR/US 매수 → 종료 → baseline 읽기 점검 → 별도 명시적 합성 재개 → 매도 두 구간을 검증한다. 기존 현금/손실/수동 보유·소유권·원가/이력을 보존하고 같은 봉의 영구 중복 키로 재매수를 막는지 확인한다. 실제 broker fetch는 차단한다. 이것은 실제 시세나 전체 CLI 실운용 실행의 검증이 아니다.

최종 로컬 전체 검증은 새 일회용 localhost PostgreSQL 17 전용 DB에서 기본 병렬 `verify:ci`로 수행했다. 129파일·1,023개 테스트(64.18초), 포맷·린트·타입·전체 빌드와 두 Compose config 검사를 통과했다. 관련 단계/원자적 이력 CAS 검사는 별도 3파일·23개 테스트로도 확인했다. 최초 구현의 전체 1,014개 통과 뒤 추가 검토에서 version 없는 거부 이력의 공백을 찾아 보강했고, 정지 관측의 실제 진단 사건도 통합 검사로 확인한 뒤 최종 전체 검사를 다시 실행했다. 원격 Actions 결과나 실제 시세 Paper 실행의 증거는 아니다. 새 의존성·스키마 마이그레이션은 추가하지 않았다.
