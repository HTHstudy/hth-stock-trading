# 기존 KR/US Paper 종료 자료의 후속 검토 — 2026-11-09

11월 9일 15:35 KST 기준 기존 파일만 읽어 [후속 유한 검증](PAPER_CONTINUATION.md)의 부모 증거 조건을 확인했다. **미국은 부모 파일 검사를 통과했고 국내는 필수 증거가 부족하다.** 현재 DB 원장과의 일치·실행 준비·재개 가능 여부를 확인한 결과는 아니다. 환경파일·DB·broker·토큰·시세·worker에 접근하지 않았고 새 관측·예약·재개·실주문·마이그레이션은 수행하지 않았다.

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

## 다음 점검과 남은 범위

1. 미국: 서버 고정 계좌·전용 DB의 **읽기 전용** 현재 checkpoint와 부모 after를 비교하고, 현재 한도/전략/준비 계획이 그대로인지 확인한다. 불일치 시 값을 맞추거나 계좌를 초기화하지 않고 변경 원인을 검토한다.
2. 국내: 기존 계좌가 기본 초기 모드의 조건을 여전히 충족하는지 읽기 전용으로 확인할 수 있다. 과거 의도/체결 0건만으로 현재 초기 현금·보유 없음·한도/설정/제어의 일치를 추정하지 않는다. 이 점검은 새 계좌 생성·이력 삭제·후속 증거 예외가 아니다.
3. 실제 실행 단계는 별도다. 최신 공식 세션·새 60표본 선행 관측과 15분 기한·실제 확정 봉·현재 제어 CAS·일일 손실 검토가 필요하며 파일 검토로 대체하지 않는다. 이번에는 실행 시각이나 예약을 만들지 않았다.

이번 변경은 점검 결과 문서화뿐이다. CLI/순수 대사 함수/예약 조회를 실제 저장 파일에 적용한 결과와 링크·포맷 검사를 확인했으며 소스·DB 변경이 없어 전체 테스트나 DB 통합 검사를 다시 실행하지 않았다. 앞선 구현의 1,023개 테스트 통과 기록은 [구현 검증](PAPER_CONTINUATION.md)에 별도로 남긴다.
