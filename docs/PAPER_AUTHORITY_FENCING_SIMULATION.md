# 구실행 권한 폐기의 비적용 합성 검증기

[설계안](PAPER_AUTHORITY_FENCING_DESIGN.md)의 거부 조건을 가짜 입력으로 검사한다. **실제 권한 폐기나 증거 인증을 수행하지 않는다.** 현재 예약 closure·감독기·Paper runner·HTTP·DB 스키마에 연결하지 않았고, 기존 a407 차단과 지침도 변경하지 않았다.

## 실행

공통 패키지와 worker의 빌드는 별도로 완료해야 한다. 명령은 빌드·환경파일·원본/증거 파일·DB·broker·collector·자식 실행을 시작하지 않는다. process의 TRADING_MODE만 paper/default인지 검사하며 live는 거부한다.

```bash
# 기본은 사용 권한이 없는 미리보기
corepack pnpm paper:authority:simulate

# 컴파일 코드에 포함된 합성 사례만 평가
corepack pnpm paper:authority:simulate --demo
corepack pnpm paper:authority:simulate --demo --case=missing-broker
corepack pnpm paper:authority:simulate --demo --case=existing-session
corepack pnpm paper:authority:simulate --demo --case=changed-file
corepack pnpm paper:authority:simulate --demo --case=cas-conflict
```

내장 사례는 complete·missing-broker·existing-session·changed-file·cas-conflict다. --case 단독·중복·알 수 없는 옵션/값·positionals·input/output 파일 경로·apply/execute는 거부한다. 원본을 입력받는 옵션이나 stdin reader는 없다. 기존 실제 기록을 가짜 자료로 바꿔 읽지 않는다.

exit 0은 미리보기 또는 합성 조건의 일관성뿐이다. 거부된 합성 사례는 exit 2, 잘못된 CLI/환경은 고정 오류 코드와 exit 1이다. 오류 원문·인수의 민감값·경로를 출력하지 않는다. 예시 `missing-broker`의 exit 2는 의도한 거부 결과다.

## 입력과 판정

worker 내부 순수 함수 `evaluatePaperAuthorityFencingSimulation`은 strict Zod 계약을 사용한다. source는 synthetic-fixture, mode는 paper로 고정한다. 실제 collector·서명·제공자 권한 확인은 없으며 공급자 operation을 추가하거나 호출하지 않는다.

| 항목      | 합성 일관성 검사                                                                                                              |
| --------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 범위      | scopeComplete와 계획/전후 snapshot/근거/승인의 scope 바인딩                                                                   |
| 제어      | legacy generation·계좌 version/epoch 일치, 다음 generation이 정확히 +1. 실제 CAS는 수행하지 않음                              |
| 승인      | policy/maintenance 각 하나, 같은 plan hash·policy revision·세대·범위·유효시간과 발급 순서                                     |
| 승인 기준 | capturedAt을 제외한 before의 보호 상태와 정규화된 원본 집합을 plan.baselineHash에 고정. 전후를 함께 바꿔도 기준과 다르면 거부 |
| 원본 집합 | 합성 run 1–100개·파일/누락 목록·크기/hash의 전후 동일성, 중복/겹침·새 run·삭제·경로형 이름·누락 선언 오류 거부                |
| 원장/이력 | business ledger·설정 hash, rejected/unresolved/retired 집계의 전후 동일성                                                     |
| 정리 상태 | 전후 모두 정지·lease 없음·열린 의도/활성 예약 없음                                                                            |
| 폐기 근거 | runtime/database/broker 각 하나, 서로 다른 proofRef·plan hash/scope/세대/revision 연결, 모든 세부 항목이 simulated-confirmed  |
| 시각      | 밀리초 정밀도의 명시적 합성 asOf, 승인→before→폐기/캡처→after→asOf 순서와 만료 검사. 만료 시각과 asOf가 같아도 거부           |

파일은 run당 최대 16개·각 32MiB·합계 64MiB의 **제공된 크기 메타데이터**만 검사한다. 실제 파일을 읽거나 바이트의 hash를 재계산하지 않는다. 현재 계약은 변경 없는 동일 scope의 보호 상태만 다루며, 계좌 제어 변경·역할/주소 이전·새 scope 연결은 지원하지 않는다.

business ledger/설정 hash도 가짜 입력의 식별자다. 같은 원장을 실제로 읽었다거나 그 hash의 원천이 진짜임을 검증한 결과가 아니다. origin의 simulated-independent-controller 표기도 실제 독립성을 인증하지 않는다. 검증 시간은 simulatedAsOf/clockSource=synthetic-fixture로 표시하며 현재 운영 시각으로 표현하지 않는다.

## 출력의 권한 경계

결과 state는 blocked 또는 consistent-synthetic-scenario다. 원본 ID·scope·근거·승인 내용은 반환하지 않고 고정 reason code·합성 입력 hash·합성 시각과 안전 플래그만 제공한다. 알 수 없는 실제/위험 필드는 INPUT_INVALID와 null 입력 hash로 거부한다. hash는 진위 인증이나 승인 토큰이 아니다.

완비 사례에서도 actualAuthorityVerified/currentAuthorityVerified/externalEvidenceAuthenticated/documentApproval/operatingApproval/policyApplied/canIgnoreReservation/executionEnabled/canResume는 모두 false다. DB/원본 접근·자격 변경·프로세스 제어·이력 변경·예외 생성·예약·재개·자동 재시도도 수행하지 않는다. CLI 오류/미리보기도 해당 권한을 부여하지 않는다.

공격자가 가짜 hash·승인·근거를 모두 일관되게 다시 만들면 합성 일관성 검사를 통과할 수 있다. 이를 숨기지 않고 회귀 검사에 포함한다. 그 경우에도 실제 인증/실행 플래그는 false이며, 이 모듈을 실제 gate나 collector의 대용으로 사용하지 않는다.

## 검증과 남은 범위

완비/근거 누락·기존 DB 세션·구 client 발급 자격·공급자 범위 미확인, scope/세대/revision/승인 불일치, 원본 변경/새 run/목록 중복/크기 초과, 원장/집계/설정/CAS/정리 상태·순서/만료·실제 입력/민감값 거부를 검사한다. 승인 계획을 바꾼 뒤 이전 증거를 재사용하면 거부한다. 원본 객체의 불변성·같은 입력의 재현성·표현 순서 독립성·내장 사례 분리도 확인한다.

CLI는 빈 임시 cwd와 가짜 민감 환경변수에서 실행하고, module loading 외의 파일 접근·네트워크·자식 생성이 시도되면 테스트에서 거부한다. 실제 증권사 호출·권한 변경·collector·예약 예외는 테스트하지 않는다. 기존 라이브러리만 사용하며 새 의존성은 없다.

2026-11-10 최종 로컬 `verify:ci`는 새 일회용 localhost 전용 테스트 DB에서 136파일·1,245개 테스트를 통과했다(테스트 구간 66.81초). 이번 핵심/CLI 테스트는 133개다. 포맷·린트·타입·전체 빌드, 개발/로컬 두 Compose 설정, 빌드된 CLI 미리보기와 5개 사례·위험 옵션 거부도 확인했다. 원격 CI나 실제 외부 권한 검증 결과는 아니다.

아직 구현하지 않은 것은 실제 신뢰 주체 식별/증거 수집·검증, 관리 작업·원자적 전환·지속적 외부 통제, 현재 지침/운영 gate 변경과 실제 관측/재개다. 이 합성 검증기의 통과가 그 구현이나 적용을 승인하지 않는다.
