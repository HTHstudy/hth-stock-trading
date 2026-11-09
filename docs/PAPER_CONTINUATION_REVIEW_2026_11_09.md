# 기존 KR/US Paper 종료 자료의 후속 검토 — 2026-11-09

첫 점검은 11월 9일 15:35 KST 기준 기존 파일만 읽어 [후속 유한 검증](PAPER_CONTINUATION.md)의 부모 증거 조건을 확인했다. **미국은 부모 파일 검사를 통과했고 국내는 필수 증거가 부족하다.** 첫 파일 점검은 현재 DB 원장과의 일치·실행 준비·재개 가능 여부를 확인한 결과가 아니다. 그 단계에서는 환경파일·DB·broker·토큰·시세·worker에 접근하지 않았다. 이후 별도로 승인된 읽기 전용 DB 점검은 아래 15:49 기록과 구분한다. 두 단계 모두 새 관측·예약·재개·실주문·마이그레이션은 수행하지 않았다.

## 시장별 확인 결과

| 항목                                    | 국내 KR                                       | 미국 US                                                    |
| --------------------------------------- | --------------------------------------------- | ---------------------------------------------------------- |
| 이전 run                                | `ac391fc5-e1ef-4121-a10d-0fb9d0bb6e2a`        | `e3c96a51-7ef8-46dc-b533-215cd38e7298`                     |
| 기록된 tick                             | completed 60 / running 60                     | completed 60 / running 60                                  |
| 의도 / 체결                             | 0 / 0                                         | 0 / 0                                                      |
| 기존 종료 / 대사                        | completed-with-incomplete-review / incomplete | completed-with-incomplete-review / incomplete              |
| request·before·after·review·result 연결 | strict 계약/hash·시각·정리 검증               | strict 계약/hash·시각·정리 검증                            |
| 같은 평가 시각의 대사 재계산            | 기존 hash 일치, failed 없음                   | 기존 hash 일치, 부모 묶음 검증 통과                        |
| 독립 소유 launch/exit                   | 현재 고정 루트에서 일치하는 launch 0개        | `87e0324c-d416-4bbb-b490-b3843c6ab916` 연결·정상 종료 검증 |
| 부모 request의 resourcesHash            | 기록 없음                                     | 기록 있음·부모 검사 통과                                   |
| 새 continuation 모드의 부모 조건        | 충족하지 못함                                 | 충족                                                       |
| 현재 DB baseline / 재개 권한            | 미확인 / 없음                                 | 미확인 / 없음                                              |

국내 대사의 미검증 항목은 intentPath·fillPath다. 미국도 [기존 결과](US_PAPER_RESULT_2026_11_06.md)의 신호/체결 없음과 incomplete 판정을 유지한다. 원장 보존·60 tick·파일 hash 일치를 체결·비용·수익성 검증 완료로 바꾸지 않는다.

국내의 과거 실행/대사 자체가 이번 새 조건 때문에 실패로 바뀌는 것은 아니다. 새 후속 모드가 요구하는 당시의 독립 종료 증거와 고정 계획 연결을 현재 자료로 확인할 수 없다는 뜻이다. 다른 run의 소유 증거를 재사용하거나 누락된 과거 request 필드·launch/exit를 소급 생성하지 않는다.

## 미국 무접속 검사

현재 빌드의 `--inspect-continuation`을 사용하고 같은 hash를 지정해 다시 검사했다. 두 번 모두 `continuation-reviewed`, `dbAccessed=false`, `executionEnabled=false`, `canResume=false`였다.

```bash
node infra/authorized-paper-validation.mjs --market=US --inspect-continuation \
  --continue-from=e3c96a51-7ef8-46dc-b533-215cd38e7298 \
  --continuation-launch=87e0324c-d416-4bbb-b490-b3843c6ab916 \
  --continuation-hash=57a28da10a85a58a0b0faae583cfdf7d845135f123455cef305ba2f720de1721
```

이 hash는 당시 부모 7파일의 내용/바이트 연결이다. 현재 계좌 상태·새 선행 관측·현재 계획과의 일치나 운용 승인을 의미하지 않는다. 원본이 바뀌면 같은 hash 검사가 실패해야 하며 자동으로 새 hash를 채택하지 않는다.

KR 5파일과 US 7파일, 총 12개 원본 파일의 바이트 hash를 재검사 전후 비교해 동일함을 확인했다. 비교용 전체 파일 묶음 hash는 `53a2202a66ea445a4e9f5938700f16bdcb438afebd37e83db55f0a680344d4f4`다. 이것은 미국 continuation-hash와 다른 보존 확인용 값이다. 원본 실행/프로세스 폴더에 파일을 추가하거나 판정을 수정하지 않았다.

## 기존 예약 감사

고정 루트의 `checkReservations()`는 available·limited=false, rejectedCount=1·retiredCount=0·unresolvedCount=1이었다. KR/US 두 run 모두 linked-review·not-in-future·stoppedAndCleaned=true로 조회됐다. 정지는 저장된 after의 상태이며 현재 DB나 프로세스 생존의 확인이 아니다.

[기존 a407의 독립 종료 근거 부재](PAPER_RESERVATION_AUDIT.md)는 그대로다. 미국 부모 검사를 통과해도 장시간 감독기의 과거 예약 차단을 해소하지 않는다. 이번 조회는 예약 처리 기록을 만들지 않았다.

## 현재 DB 읽기 전용 점검 — 15:49 KST

후속 점검에서는 서버 고정 manifest의 기존 두 계좌와 현재 검증 계획을 확인하고, 전용 localhost DB에 비관리자 `hth_test`로 연결했다. root 환경파일이나 토스 키는 읽지 않았으며 Paper 전용 서버 환경파일의 접속 설정만 메모리에서 사용했다. 세션 기본 `default_transaction_read_only=on`과 현재 `transaction_read_only=on`을 확인하고, 기존 helper의 repeatable-read/read-only snapshot만 조회했다. HTTP fetch도 거부하도록 설정했다. 계좌 ID·접속 URL·원본 원장/감사·비밀값은 출력하거나 저장하지 않았다.

| 항목                                     | 국내 KR         | 미국 US           |
| ---------------------------------------- | --------------- | ----------------- |
| DB 조회 시각 KST                         | 15:49:05.275433 | 15:49:05.314777   |
| DB 시각/출처/고정 계획                   | 일치            | 일치              |
| 정지·lease 없음·열린 의도/활성 예약 없음 | 확인            | 확인              |
| 기본 runner 초기 모드의 12개 준비 조건   | 모두 일치       | 모두 일치         |
| 후속 모드의 공통 7개 준비 조건           | 모두 일치       | 모두 일치         |
| 미국 부모 after와 현재 checkpoint        | 해당 없음       | asOf 외 전체 동일 |
| 미국 부모 resourcesHash와 현재 검증 계획 | 해당 없음       | 일치              |
| 오프라인 최초 상태 15개 조건 전체        | 불일치 2개      | 불일치 2개        |
| KRW 저장 날짜 → 현재 날짜                | 11/3 → 11/9     | 11/6 → 11/9       |
| USD 저장 날짜 → 현재 날짜                | 11/3 → 11/9     | 11/5 → 11/9       |
| 일일 기준 검토                           | 필요, 미적용    | 필요, 미적용      |

기본 runner의 12개 조건은 paperSource·stopped·noLease·limitsMatch·initialCash·emptyPositions·noOrders·noFills·noReservations·strategyMatches·historyMatches·preparationReceipt다. 최초 오프라인 준비 검사와 달리 initialControl·unreconciled·initialPnl은 이 목록에 포함되지 않는다. 두 계좌의 오프라인 최초 검사에서 불일치한 것은 initialControl·unreconciled뿐이며, 이미 관측/실행한 계좌를 처음 생성한 상태로 표시하지 않은 결과다. 초기값으로 복구하지 않았다.

국내는 이 점검 시점에 **기존 계좌의 기본 초기 모드 준비 조건을 충족**한다. 독립 부모 증거가 없어 새 continuation 모드를 사용할 수 없다는 앞선 결론과 별개다. 미국은 현재 기본 초기 모드 조건도 충족하며, 부모 증거·현재 baseline·계획 연결의 추가 조건도 일치한다. 어느 결과도 실제 시장/일일 검토/실행 권한을 포함하지 않는다.

두 계좌의 checkpoint는 읽은 시각만 제외하고 재조회 전후 동일했고, 준비 조회의 계좌·전략·불변 이력·준비 영수증·주문/체결/예약 개수도 조회 시각 외 동일했다. 이전 미국 부모와 현재 비교는 `verifyPaperContinuationBaseline`을 그대로 사용했다. 새 checkpoint 파일·제어 기대값·실행 UUID·예약·관측 자료를 만들지 않았다. 모든 출력은 executionEnabled=false·canResume=false·marketReadiness=not-checked다.

## 남은 실행 전 검토

1. 현재 DB의 설정/원장 조건 확인은 완료했다. 실제 실행 시에는 다시 읽고 version/epoch·원장·계획의 변화를 검사해야 한다. 이번 결과를 계속 유효한 실행 권한으로 보관하지 않는다.
2. 두 계좌의 일일 기준 검토는 아직 적용하지 않았다. carry-negative-pnl-v1과 현재 제어 기대값·신선한 전체 보유분 평가를 별도로 확인해야 하며 날짜·손실을 직접 수정하지 않는다.
3. 실제 실행 단계에는 최신 공식 세션·새 60표본 선행 관측과 15분 기한·실제 확정 봉·현재 제어 CAS가 필요하다. 파일/DB 조회로 대체하지 않는다. 이번에는 실행 시각이나 예약을 만들지 않았다.

이번 변경은 점검 결과 문서화뿐이다. CLI/순수 대사 함수/예약 조회의 실제 저장 파일 검사, 기존 준비 조회·부모 baseline 검사의 실제 읽기 전용 DB 적용, 전후 보존과 링크·포맷 검사를 확인했으며 소스·DB 변경이 없어 전체 테스트나 DB 통합 검사를 다시 실행하지 않았다. 앞선 구현의 1,023개 테스트 통과 기록은 [구현 검증](PAPER_CONTINUATION.md)에 별도로 남긴다.
