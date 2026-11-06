# Paper 전략 준비 봉과 시작 시각

## 11월 4일 미국 중단

`e7427018-3c6b-4a3e-ab3e-6aa6560b0b54`는 11/4 23:35 KST에 stopped-observation 단계에서 중단됐다. 최종 기록은 runStarted=false·0 tick·정지/정리 완료다. 실제 정규장과 시장 데이터 품질 검사는 통과했지만 확정봉이 4개였다. MA 5/20 교차 계산에는 직전·현재 평균을 비교할 21개가 필요해 기존 preflight가 재개를 차단했다.

이는 앞선 계획 파일 누락과 다른 실패다. 이전 실패 코드 PAPER_PREFLIGHT_FAILED와 모든 원본 파일을 보존한다. 당시 원본 페이지는 보관하지 않아 응답 전체/페이지 범위를 단정하지 않으며, [수집기 점검](PAPER_WARMUP_COLLECTION.md)은 가짜 시세로 개장 5분 뒤 4개를 재현한 결과다. collector를 바꾸거나 API endpoint/요청 타입을 추측하지 않았다.

## 무접속 시작 계획

```bash
corepack pnpm paper:warmup:plan

# 공식 캘린더에서 확인한 세션을 입력한다. 예시 시각은 11/5 거래일이다.
corepack pnpm paper:warmup:plan --fast-period=5 --slow-period=20 \
  --session-start=2026-11-05T14:30:00Z --session-end=2026-11-05T21:00:00Z
```

기본은 사용법 미리보기다. 계획 계산은 키·DB·broker·파일 접근이나 자식 생성 없이 기존 Zod/시장 데이터 정책/hash만 사용한다. 모듈 코드 로딩 외의 I/O를 수행하지 않는다. 실행/재개 옵션은 없다.

- 필요 확정봉은 실제 전략 설정의 `slowPeriod + 1`이며 현재 Paper 수집 한도에 따라 200개 이하만 허용한다.
- 현재 세션의 첫 완전한 1분 구간부터 필요한 봉이 생기는 시각에 `marketDataPolicy.settlementDelayMs`(현재 60초)를 더한다.
- MA 5/20의 이론상 최초 시각은 개장 22분 뒤, 기본 여유 3분을 더한 봉 준비 시각은 25분 뒤다. 실제 권장 시작은 아래의 일일 기준 경계 검사까지 통과한 시각이다. 초 단위로 개장하는 세션은 첫 완전한 분 구간으로 올림한다.
- 기본 절차 기한은 시작 후 25분이며 최소 절차 예산은 12분이다(60 tick의 10초 간격과 준비/정리 여유; 지연 없는 완료를 보장하지 않는다). KRW와 USD의 기존 일일 기준을 시작과 종료 기한에 각각 비교한다. 기본 추천은 경계가 있으면 경계 5분 뒤로 옮기며, 명시한 시작 창이 경계를 가로지르면 TRADING_DAY_BOUNDARY로 차단한다. 일일 기준 자체를 바꾸거나 손실을 초기화하지 않는다.
- 기한이 정규장 종료에 닿거나 넘는 경우, 시작 전/종료 후, 30분 초과 실행 창은 차단한다.
- `--start-at`과 `--deadline`을 명시하면 기존 예약안을 검토한다. 개장 5분 뒤는 theoreticalClosedCandlesAtStart=4·WARMUP_TIME_TOO_EARLY로 blocked/exit 2다.

계획은 누락 없는 현재 정규장 분봉의 시간상 가능성을 계산한다. broker가 모든 분을 반환하거나 한 페이지 안에 필요한 확정봉이 있다는 보장이 아니다. 누락 분을 합성하거나 과거 isClosed/dataQuality 플래그로 대체하지 않는다. actualCandlesVerified/sessionVerified/scheduled/executionEnabled/canResume는 false다. 이 계획 hash는 운용 승인이 아니다.

## 실행기의 이중 검사

새 `authorized-paper-validation.mjs` 실행에는 `--session-start`, `--session-end`가 필요하다. 승인된 고정 계획을 다시 hash 검증해 전략 주기를 읽고, 실제 대기에 들어가기 전 시작 시각/종료 기한을 계산한다. 너무 이른 시작은 PAPER_STRATEGY_WARMUP_INSUFFICIENT로 키·DB·계좌·대기·새 실행 기록 생성 전에 거부한다. 별도 프로세스/토큰을 시작해 사전 검사를 우회하지 않는다.

입력을 통과하면 요청과 함께 `warmup-plan.json`을 보관한다. 이후 날짜/손실 검토·정지 상태 실제 시세 검사·현재 계좌/lease/version/epoch·구성 검사는 기존 절차를 유지한다. 최신 수집 프레임의 실제 캘린더에 같은 regular 세션이 있는지도 확인한다.

실행 직전에는 `prepareStrategyData`의 신선한 결과를 받아 활성 종목/전략별로 필요한 개수를 검사한다. 비활성 전략은 봉 개수 검사에서 제외하고 활성 전략이 없으면 구성 변경으로 차단한다. 이전처럼 가장 긴 slowPeriod를 다른 모든 종목에 일괄 적용하지 않는다. 시장 데이터 불가/만료는 일반 preflight 차단을 유지하고, 데이터 검사를 통과했지만 개수만 부족하면 새 전용 코드로 중단한다. `preflight-evidence.json`에 시간 계획과 전략별 required/available/missing/dataReady/reason을 보관한다.

새 코드의 웹 문구는 **전략 계산에 필요한 확정 봉 부족**이다. 과거 일반 실패는 그대로 표시하며 재개·완료로 승격하지 않는다. 전략/한도를 낮춰 체결을 유도하지 않았고 Paper resume 기본값·실주문 비활성·정지/복구·손실 이월 정책도 유지한다.

## 고정 코드와 운영 root

`paper:validation:owned`는 같은 session-start/end를 고정 runner에 전달한다. `--build-root`가 있으면 그 코드 root의 `infra/authorized-paper-validation.mjs`를 고정 경로로 선택하며, 현재 workspace는 서버 환경/계좌 manifest/실행 기록 root로 유지한다. 코드 root에는 runner와 공개 산출물·의존성이 모두 있어야 한다. 키/환경/계좌 파일을 코드 복사본으로 옮기지 않는다. root를 HTTP/브라우저에서 받지 않으며 부모의 키/NODE_OPTIONS는 자식에 복사하지 않는다.

## 실제 단발 진단

11/5 10시 무렵 전용 Paper DB의 두 계좌를 전후 읽기 비교하면서 기존 client/DB advisory lock 안에서 국내 시장 데이터를 단 한 번 조회했다. 당시 KR:005930 원본 200봉·검증된 확정봉 63개로 필요 21개를 충족했다. market-data-only 범위이며 account/risk/Paper 실행 준비 검증은 아니다. 평가 값은 만료될 수 있어 실행 승인으로 재사용하지 않는다.

같은 소유자의 공식 미국 캘린더 조회로 처음 계산한 봉 준비 후보는 11/5 23:55~11/6 00:20 KST였다. 이후 원장의 두 통화 일일 기준이 한국 자정에 바뀌는 것을 확인해 이 창을 철회했다. v2 계획의 권장은 **11/6 00:05~00:30 KST(미국 11/5 정규장)**다. 새 예약/재개는 시작하지 않았다. 원장 전후 hash는 같았으며 보존한 증거는 `.local-data/paper-warmup-checks/78b203f9-5da6-4ca7-8269-b9a2428c3c4e/result.json`이다. 원본 가격·계좌 응답·인증 정보는 기록하지 않았다.

이 작업은 과거 요청 누락 1건의 예약 예외 정책과 별개다. 그 차단 규칙을 변경하거나 기존 실패/종료 증거를 고쳐 쓰지 않는다.

시작 시각 추정은 현재 정규장만으로 준비 시간을 확보하는 보수적인 기준이다. 실제 전략 입력은 기존 정책을 유지해 제공된 캘린더에서 검증된 이전 영업일 확정봉도 사용할 수 있다. 이전 봉을 임의로 current-session 봉으로 바꾸거나 새로 생성하지 않는다.

## 자정 경계 보정과 준비본 철회

원장의 valuationStale/관측/예약 검사는 전략 시장과 별개로 KRW·USD 두 날짜를 확인한다. 따라서 US 전략만 실행해도 23:55~00:20 창은 KRW 일일 기준을 넘는다. 미국 20시 거래일 전환은 한국 오전 9시/10시이므로 국내장 창에도 같은 검사가 필요하다. 계획기는 원장이 쓰는 공개 marketTradingDate를 재사용하고, deadline까지 두 통화 날짜가 동일해야 한다. 관련 검증은 plan v2에 포함한다.

초기 고정 준비본 `dde17d63-8da5-439b-90ab-6475f6d1bf16`은 예약되지 않은 상태에서 `withdrawal.json`을 별도 생성해 철회했다. 원래 plan/code/증거는 수정하지 않았다. 실제 재개 시 일일 기준 검토는 그때 새로 생성하며, 보정된 창에서는 KRW 11/6·USD 11/5가 된다. 오전 준비 시 생성한 KRW/USD 11/5 미리보기를 재사용하지 않는다.

## 최종 고정 준비본과 검증

일일 기준 경계를 반영한 새 준비본은 `.local-data/paper-warmup-preparations/aeb8a664-5bd0-4067-b72d-cb189ebdf4d6/`다. 소스 commit `bb98712`의 공개 코드/의존성 16,875파일·내부 symlink 1,231개를 복사하고 목록/hash를 기록했다. 키·환경·계좌 자료는 코드 root에 복사하지 않았다. 고정 실행기/컴파일 코드/lockfile fingerprint는 `28601690a0b77d0ee6b523d0298540961141cfd780566dfbd02ec6c54f84f7e7`다.

별도 inputs/manifest와 현재 US 계좌 제어 조건을 고정했고 읽기 전용 준비 검사를 통과했다. KR/US Paper 원장의 전후 hash는 동일했다. 별도 무접속 확인에서도 plan/warmup v2/build hash와 고정 입력이 일치했고 dbAccessed=false였다. 상태는 prepared-not-started, scheduled/resumeRequested/executionEnabled/canResume=false다. 기존 철회 준비본은 재사용하지 않는다.

최종 기본 테스트 584개와 타입·린트·전체 빌드·포맷 검사를 통과했다. DB 통합 102개는 기본 실행에서 제외됐다. 관련 테스트는 원본 수집 보존·5분/25분 준비 봉·거래일/DST/조기 종료·최소 절차 예산·대기 전 무접속 거부·종목별 개수·전용 실패 표시·고정 코드와 운영 root 분리를 검증한다. 실제 시장 데이터 진단은 테스트와 구분해 위 private 증거에 보관했다.

## 11월 5일 소유 래퍼를 통한 새 예약

사용자 진행 요청에 따라 13:49 KST에 위 최종 고정 준비본으로 일회성 예약을 연결했다. 원본 plan.json은 prepared-not-started로 보존하고 새 dispatch·request·launch 증거를 별도 저장했다.

- 실행 창: **11/6 00:05~00:30 KST**, 미국 11/5 정규장, 최대 60 tick.
- run: `e3c96a51-7ef8-46dc-b533-215cd38e7298`.
- owned launch: `87e0324c-d416-4bbb-b490-b3843c6ab916`.
- batch: `cdad5dfb-e64a-43d9-94f0-3a7c7e2c1730`.
- `.local-data/paper-validation-batches/<batch>/`의 launch-verification.json·process-verification.json·ledger-verification.json, 소유 프로세스 루트의 launch.json, 실행 루트의 request.json·warmup-plan.json을 확인했다.

고정 build/input/control hash·현재 계좌 정지/lease 없음·준비 조건·선행 관측의 최종 hash를 재검증했다. 도구 종료 뒤에도 소유 래퍼·그 자식 실행기·PID 수명에 연결한 caffeinate의 생존을 별도 확인했다. 13:51 KST 조회에서 두 Paper 원장은 예약 전 hash와 같고 정지/lease 없음이 유지됐다. PID/프로세스 생존은 이 확인 시점의 증거이며 실행 성공을 뜻하지 않는다.

새 request는 resumeRequested=true지만 현재 Paper tick은 시작하지 않았다. 예약 대기에는 토큰/증권사 연결을 만들지 않는다. 시작 시 최신 일일 기준/손실 이월 검토·정지 시세 관측·실제 확정 봉 개수·현재 계좌 CAS·체크포인트를 다시 검증하고 명시적 재개 절차를 따른다. 시작 누락·검사 실패·기한 종료 시 다음 날 이월하거나 자동 재시도하지 않는다. PC 종료·덮개 닫기·수동 절전·재부팅 후 자동 복구는 제공하지 않는다.

이번에는 소유 래퍼가 직접 실행한 자식의 종료를 관찰해 exit.json을 남기므로 향후 원본 보존형 예약 정리의 독립 증거를 확보할 수 있다. 아직 exit/result/checkpoint 대사 결과는 없으며, 과거 요청 누락 예약의 정책이나 증거는 변경하지 않았다. 실제 주문 권한은 계속 비활성이다.

## 11월 6일 종료 확인

위 새 예약은 00:15:46 KST에 60 tick 종료·정리됐다. 필요 21봉 대비 실제 확정 봉 34~44개로 봉 부족 문제는 재현되지 않았고, 기록된 진단 22건은 모두 HOLD/NO_CROSS였다. 의도/체결 0이므로 체결 경로는 미검증으로 남긴다. [최종 결과](US_PAPER_RESULT_2026_11_06.md)를 따르며 준비·예약 당시 파일은 그대로 보존한다. 새 예약이나 재개는 하지 않았다.
