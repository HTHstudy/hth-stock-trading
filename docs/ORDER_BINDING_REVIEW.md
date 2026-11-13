# 합성 주문 의도·계좌·전략 연결 검사

2026-11-12 [바인딩 설계](ORDER_BINDING_DESIGN.md)의 첫 단계인 strict 입력/결과 계약과 순수 함수를 구현했다. **가짜 주장들 사이의 일관성 검사**다. 실제 계좌 소유권·접수 증거를 인증하지 않으며 금융 기준/바인딩을 생성하거나 원장·거래 권한을 부여하지 않는다.

## 코드와 의존성

- [contracts](../packages/contracts/src/synthetic-order-binding.ts): syntheticOrderBindingInputSchema·syntheticOrderBindingReviewSchema와 공개 타입. source/environment는 synthetic-fixture만 허용한다.
- [trading](../packages/trading/src/execution/synthetic-order-binding.ts): reviewSyntheticOrderBinding(unknown). broker·DB·worker·네트워크·파일·현재 시각에 의존하지 않는다. 기존 Zod/decimal.js를 사용하며 새 의존성은 없다.
- [테스트](../packages/trading/src/execution/synthetic-order-binding.test.ts): 가짜 입력만 사용한다. HTTP/CLI/worker main·합성 세션·Paper·DB 저장소에 연결하지 않았다.

이 계약의 synthetic-acceptance/attempt는 내부 가짜 자료다. Toss 응답 필드·clientOrderId·멱등성·접수 증거가 이런 형태라고 가정해 구현한 DTO가 아니다.

## 입력과 검사

| 입력                               | 확인하는 연결                                                                                             |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------- |
| context                            | broker+synthetic 환경+내부 계좌의 영구 namespace, 기대 scope와 현재 연결 세대                             |
| candidate                          | 제안된 binding UUID·namespace·intent·소유 전략/revision/hash·요청 hash·영구 신호 키·주문 reference        |
| intent                             | 먼저 기록됐다고 주장하는 의도·동일 소유 전략·불변 요청 내용/키·기록 시각                                  |
| attempt / acknowledgement          | 같은 의도/요청/attempt·최초 연결 세대·주문 reference·접수 종류·시각                                       |
| observationNamespace / observation | 관측의 계좌 문맥·scope·주문 identity·종목/통화/방향·요청 조건                                             |
| registry                           | 완전하다고 주장하는 기존 연결 목록. 최대 256개. 목록 자체의 UUID/계좌별 의도·신호·주문 중복과 후보의 충돌 |

모든 객체는 strict다. 추가 권한/토큰 필드·다른 source·깨진 hash·목록 상한 초과는 INPUT_INVALID로 차단한다. UUID는 파싱 시 소문자로 정규화해 같은 UUID를 대소문자로 다른 계좌/바인딩처럼 취급하지 않는다. 주문 reference는 opaque 값으로 대소문자를 임의 변경하지 않는다.

의도의 실제 경제적 요청도 관측과 비교하므로 같은 requestHash를 복사한 것만으로 수량/가격/종목 변경이 통과하지 않는다. 십진 5/5.000은 같은 값이고 optional의 누락/null은 다른 값이다. 양의 수량 기반 지정가/시장가와 알려진 유효 조건만 검사하며 금액 주문·unknown 정의/관측·변경 거부 관측은 지원하지 않는다.

시각은 기존 관측 계약과 같은 밀리초 ISO instant만 허용한다. 의도 기록 ≤ attempt 기록 ≤ 주문 시각 ≤ 접수 시각 ≤ 관측 시각을 비교하고 offset은 같은 instant로 해석한다. 고정밀 값을 잘라 순서를 판정하지 않는다. 이 시간 순서는 합성 입력의 보수적인 가정이며 실제 broker 시계 동기화·현재 신선도·운용 세션/세대 유효성은 증명하지 않는다.

현재 연결 세대가 바뀌어도 영구 namespace나 최초 attempt/접수 세대를 새 값으로 덮지 않는다. 최초 두 자료의 출처 세대는 서로 같아야 한다. 과거 소유 전략/revision도 의도와 후보가 같아야 하며 최신 전략 설정으로 재분류하지 않는다. 이 함수는 최신 활성 설정이나 실행 제어를 조회하지 않는다.

## 결과와 중복

| outcome                      | 의미                                                                                                      |
| ---------------------------- | --------------------------------------------------------------------------------------------------------- |
| consistent-synthetic-binding | 가짜 입력 안의 연결/조건이 서로 일치함. 저장/인증/실제 소유권을 뜻하지 않음                               |
| unchanged-synthetic-binding  | 완전하다고 제출된 목록에 같은 영구 UUID/내용이 존재함. 새 바인딩을 만들지 않음                            |
| unassigned                   | 의도/후보/attempt/접수 근거가 없거나 접수가 uncertain/unattributed. 같은 종목/수량으로 추정 편입하지 않음 |
| blocked                      | 계약 오류 또는 연결/경제 조건/순서/기존 목록에 모순/미지원 조건이 있음                                    |

같은 계좌의 영구 의도·신호·주문은 새 binding UUID로 다시 연결하지 못한다. 기존 binding UUID를 다른 계좌/내용으로 바꿔 사용하는 것도 차단한다. 다른 계좌의 같은 주문 문자열은 별도 namespace다. 기존 목록에 중복이 있거나 complete=false이면 차단하며 조용히 목록을 잘라 정상으로 표시하지 않는다.

nullable 근거의 누락/불확실 접수는 먼저 unassigned로 반환한다. 이 경우 나머지 충돌 검사를 모두 수행한 결과라고 주장하지 않는다. malformed 입력은 그보다 먼저 INPUT_INVALID다. 결과에는 고정 outcome/reason 코드만 넣고 식별자·입력·검증 오류 원문을 반환하지 않는다.

모든 결과는 bindingPersisted/evidenceAuthenticated/financialBaselineEstablished/ledgerApplied/canApplyToLedger/ownershipVerified/executionEnabled/canResend/canResume=false다. 첫 관측이 부분 체결이거나 비용이 null이어도 영(0) 금융 기준·새 체결·현금/소유권/원가를 만들지 않는다.

## 증명하지 않는 범위와 다음 단계

scope·정의/request hash·complete=true·synthetic-acceptance는 **호출자가 준 주장**이다. 이 함수는 hash의 원문 진위·영구 신호 키의 생성 근거·DB 전체 목록의 완전성·실제 접수/계좌 소유권을 인증하지 않는다. 일치하는 가짜 hash를 바꿔도 실제 권한 플래그가 true가 되지 않는 것을 테스트한다.

관측의 누적 수량/비용/원장 정합성·현재 매도 가능량·전략 수량·리스크 한도 검사는 이 함수의 범위가 아니다. 실제 금융 대사는 기존 순수 비교와 향후 계좌 잠금/바인딩/적용 키 검증이 필요하다. 연결 일치 결과로 Paper fill이나 실제 주문을 실행하지 않는다.

다음은 전용 테스트 DB의 별도 합성 바인딩 저장소다. 계좌/의도/바인딩을 연결하는 고유 키·복합 FK·CAS와 불변 이력을 트랜잭션 안에서 검사하고, 두 pool 경합·재조회·새 UUID 우회·기존 Paper/order_review 보존을 검증한다. 이번에는 스키마/마이그레이션·그 저장소를 구현하거나 실제 계좌/자료를 연결하지 않았다.

## 검증

신규 가짜 입력 76개와 기존 누적 대사 51개, 관련 127개 테스트가 통과했다. 계좌/의도/전략/revision/요청/참조 불일치, 미배정/unknown, 기존 영구 키/중복 목록·불완전 자료, 경제값 표기/nullable·시각 역전/고정밀·UUID 대소문자, 모든 false 플래그·입력 보존·원문 비노출을 검사한다. 테스트는 실제 broker/계좌 API를 호출하지 않는다.

최종 로컬 `verify:ci`는 새 일회용 localhost 전용 DB에서 **149파일·1,564개 테스트**를 통과했다(테스트 구간 72.09초). 포맷·린트·타입·전체 빌드·두 Compose 설정·문서 링크/diff 검사도 통과했다. 원격 Actions 결과·실제 계좌/소유권/거래 검증으로 확대하지 않는다. DB는 기존 통합 검사 실행에만 사용했으며 새 바인딩 테이블이나 사용자 마이그레이션은 적용하지 않았다.

11월 13일 후속 [합성 연결 영구 저장소](ORDER_BINDING_STORE.md)를 전용 테스트 DB capability로 추가했다. 선기록 의도/고유 연결·복합 FK/CAS·불변 이력만 다루며 실제 인증/금융 적용은 하지 않는다.
