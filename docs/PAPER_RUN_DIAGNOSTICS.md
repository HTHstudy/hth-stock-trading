# 실행 구간별 Paper 진단

`/paper`의 저장 실행 상세에서 해당 구간의 **신호·평가 단계·기록된 사유**를 집계한다. API는 기존 소유자 cookie/localhost 읽기 전용 실행 기록 경계를 그대로 사용한다. 계좌·전략·종목·이벤트 식별자, epoch/version, hash, 경로, 원본 진단은 HTTP에 노출하지 않는다. 실시간 시세 수집·재평가·worker 실행·재개·주문은 없다.

## 구간 연결과 보관

기존 before/after checkpoint에는 진단 이벤트 key만 있어 마지막 진단 조회를 구간 전체로 확대할 수 없다. 서버에서 별도 읽기 전용 capture를 수행해 UUID 실행 폴더의 `diagnostics.json`에 보관한다. 기존 실행·체크포인트·대사 파일을 덮어쓰지 않는다. 기본은 키/DB/파일 접근이 없는 미리보기다.

```bash
corepack pnpm paper:run:diagnostics
```

명시적 capture는 서버 운영자가 기존 실행 UUID와 그 계좌를 지정한다. 브라우저는 계좌/경로를 지정하지 못한다. 빌드는 별도이며 명령이 자동 빌드·마이그레이션을 수행하지 않는다. 서버 DB 설정은 명시적으로만 로드한다.

```bash
node --env-file=.local-data/paper-market-local/.env \
  apps/worker/dist/paper-run-diagnostics-run.js --capture \
  --run=<RUN-UUID> --account=<SERVER-MANIFEST-ACCOUNT>
```

localhost 전용 `hth_readonly_test`/`hth_test` DB와 `paper-market-*`·toss-readonly 출처만 허용한다. scope는 계좌·출처·접속 DB/role/host/port에서 다시 계산해 두 checkpoint와 대조한다. repeatable-read/read-only 트랜잭션과 3초 statement timeout에서 최대 5,000개의 진단 이벤트를 확인한다. baseline에 없고 after에 있는 진단 key 집합 전체가 존재해야 하며 최신 20개로 대체하지 않는다. after 이후의 진단은 포함하지 않는다. 보관 파일은 최대 8MiB, 0600/새 디렉터리 0700이며 기존 공통 원자적 생성기를 사용해 덮어쓰기를 거부한다.

원본 batch의 strict schema·내용 hash·source/version/epoch·구간 시각을 검증하고 before/after hash·scope·이벤트 집합에 연결한다. 타임스탬프 경계는 마이크로초를 보존한다. checkpoint 이벤트 key는 진단 내용을 직접 서명하지 않는다. 서버 소유자가 보관 파일을 만드는 신뢰 경계이며 hash를 다시 계산하는 동일 권한 작성자의 위조나 원천 데이터 진위를 공증하지 않는다. [기존 파일 조회 경계](PAPER_VALIDATION_STATUS.md)의 부모 디렉터리 경쟁 한계도 유지한다.

## 표시와 해석

- 각 batch 안의 전략별 보고를 한 판단 기록으로 집계한다. BUY/SELL/HOLD와 신호 평가 전 단계(action=null), stage, 허용된 사유별 수를 별도로 표시한다. 한 보고에서 중복된 사유 코드는 한 번만 세고 여러 사유는 각각 센다.
- 동일 의미의 진단은 30초 안에 저장을 생략하므로 판단 기록 수는 tick 수가 아니다. BUY/SELL은 예약·주문 의도·체결 수가 아니다. 실제 의도/체결 수는 기존 대사 집계를 사용한다.
- after의 진단 이벤트 전체와 파일 집합이 일치해도 모든 tick의 판단·장애를 기록했다는 뜻은 아니다. 보고되지 않은 tick·전략의 원인을 추정하지 않는다. 과거 설정과 데이터의 현재 유효성도 주장하지 않는다.
- 파일이 없으면 **연결된 진단 자료 없음**이다. 부분/변조/누락/크기 초과 등으로 진단을 검증할 수 없으면 **진단 자료 검증 불가**로 표시하고 실행 종료 기록은 유지한다. 진단 오류를 HOLD나 진단 0건으로 바꾸지 않는다.
- 실시간 전략 진단과 다른 과거 구간 집계이며 현재 설정이나 마지막 진단으로 대체하지 않는다. 조회로 파일을 생성하거나 DB를 조회하지 않는다. 파일 읽기는 기존 전체 64MiB 예산을 공유한다.

## 실제 적용과 검증

2026-11-03 국내 실행 `ac391fc5-e1ef-4121-a10d-0fb9d0bb6e2a`의 저장 이벤트 22개를 모두 연결했다. 판단 기록 22건 모두 strategy 단계의 HOLD/NO_CROSS이며 새 의도/체결은 기존 대사 기준 0건이다. 이는 기록된 판단 22건에 대한 설명으로, 60 tick 모두의 진단이나 전략 수익성 검증을 뜻하지 않는다. capture 전후 계좌 checkpoint에서 조회 시각을 제외한 hash가 같았다.

미국 예약 실행과 고정 빌드는 변경하지 않는다. 그 실행에 아직 before/after 증거가 없으면 자료를 생성하지 않는다. 종료 후 별도 capture가 필요하며 조회나 이번 CLI가 실행을 예약하거나 재개하지 않는다.

단위 검사는 구간·hash·중복/누락 이벤트·출처/version/epoch·마이크로초·원문 제외·미리보기·합계·렌더링을 검증한다. DB 통합 검사는 새 UUID 합성 fixture만 사용하고 마이그레이션 없이 기존 전용 테스트 DB에서 scope·구간 외 제외·누락 거부·read-only/원장 보존을 확인한다. 실제 broker는 호출하지 않는다.
