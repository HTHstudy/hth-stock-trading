# 로컬 Paper 대시보드

## 현재 범위

웹의 `/paper` / **Paper 모의매매** 메뉴는 별도 모의 원장을 조회한다. 실행 제어·worker 소유권과 만료·평가 시각, KRW/USD별 자산·현금·예약/가용 현금·보유 평가액·일일 평가손익, 수동/전략별 보유 수량, 전략 등록 상태와 최근 주문·체결·운영 이벤트/실패 이력을 제공한다. DB에 저장된 출처를 합성/실제 시세/미확인으로 구분한다. 실제 시세여도 자산·체결·성과는 별도 모의 원장이다. 실제 계좌 현황/백테스트와 별도 페이지다.

계좌·현금·원가를 만들거나 전략/worker를 시작하는 조회 동작은 없다. 설정되지 않으면 **아직 연결된 모의 계좌가 없습니다**를 표시하고 가짜 잔고를 넣지 않는다. API 장애 시 마지막 수신값과 오류를 구분하고, 만료된 평가·lease를 정상 실행으로 표시하지 않는다. 프론트엔드는 금액을 표시만 하며 계산은 서버의 100자리 decimal.js 정밀도를 사용한다. 새 외부 라이브러리는 추가하지 않았다.

현재 연결은 localhost의 hth_test/hth_readonly_test 전용 DB로 제한한다. 기본 `PAPER_DASHBOARD_KIND=synthetic`은 `PAPER_DEMO_DATABASE_URL`/`PAPER_DEMO_ACCOUNT_ID`(`paper-demo-*`)를, `market`은 `PAPER_MARKET_DATABASE_URL`/`PAPER_MARKET_ACCOUNT_ID`(`paper-market-*`)를 선택한다. 한 번에 서버가 정한 한 계좌만 연결한다. [소유자 인증](OWNER_AUTH.md)과 [전략 파라미터/활성 편집](STRATEGY_SETTINGS.md)을 추가했다. 실제 시세 CLI 계좌 조회도 지원하며 일반 계좌 선택/생성 UI·인터넷 배포·실제 주문은 후속이다. 재개 버튼은 제공하지 않는다. 등록 활성 상태와 실행 중 상태를 구분한다.

## API와 공개 데이터

| 경로                | 동작                                                           |
| ------------------- | -------------------------------------------------------------- |
| GET /v1/paper       | 서버에 설정된 한 모의 계좌의 DTO, 기본 비활성 시 disabled/null |
| POST /v1/paper/stop | 빈 JSON `{}`만 받고 해당 모의 계좌에 정지/새 epoch 기록        |

브라우저가 계좌·DB URL·한도·정지 사유를 전달하거나 바꿀 수 없다. query parameter도 거부한다. DTO는 Zod strict 계약으로 검증한다. 계좌 ID·lease token·원본 요청/decision·신호/요청 hash·원본 감사 상세를 반환하지 않는다. 알려진 제어 사유·이벤트·거부 코드만 공개하고 나머지는 OTHER/제외로 처리한다. 원본 예외·SQL·계좌/인증 정보는 로그나 응답에 넣지 않는다. 시간은 ISO UTC로 정규화하고 화면에 서울 시각을 표시한다.

GET은 read-only repeatable-read 트랜잭션으로 ledger·예약·이력을 같은 snapshot에서 읽는다. worker의 계좌 행 잠금을 얻지 않으며 자원·제어·version을 변경하지 않는다. 조회 statement timeout은 3초다. 인덱스 마이그레이션 `0004_right_mauler.sql`은 계좌별 최근 주문·체결·이벤트 조회를 지원한다. 마이그레이션은 생성 후 임시 테스트 DB에서만 검증했으며 API 시작 시 자동 적용하지 않는다.

이력은 각 종류 **최근 50개**로 제한하고 이전 기록 존재 여부를 표시한다. 반복적인 ACCOUNT_OBSERVED 이벤트는 운영 이력에서 제외하되 DB에서는 보존한다. 전체 이력 검색·페이지네이션·내보내기와 별도 실패 전용 검색은 후속이다. DB 장애로 실패 트랜잭션 자체가 커밋되지 않았다면 해당 실패의 DB 감사 이력도 없을 수 있다.

## 긴급 정지 의미

버튼은 `DASHBOARD_EMERGENCY_STOP`을 기록한다. 계좌 행 잠금을 공유하므로 먼저 커밋된 정지/epoch는 이후 예약·체결을 무효화한다. 응답은 **정지 기록 커밋 확인**이며 이미 진행된 체결 취소나 잔량 정리 완료를 의미하지 않는다. worker가 다음 검사에서 중단하고, 같은 token을 소유한 경우에만 잔여 의도를 정리·lease 해제한다. worker가 죽었으면 다음 소유자의 복구가 필요하다. 기존 보유 주식과 원가는 유지하며 자동 매도·자동 재개하지 않는다.

브라우저는 mutation을 자동 재시도하지 않는다. 성공 후 조회 캐시를 무효화한다. 응답이 불확실하면 **정지 여부를 확인하지 못했습니다**를 표시한다. 최신 상태를 조회하고 운영자가 필요하면 정지를 다시 요청한다. 클라이언트 상태만으로 성공을 꾸미거나 worker를 재개하지 않는다.

API는 소유자 세션을 요구하며 기존 localhost 경계도 유지한다. loopback peer·허용 Host·정확한 Origin·Sec-Fetch-Site를 검사하고 POST에는 `x-hth-dashboard: 1`을 요구한다. CORS를 공개하지 않으며 응답은 no-store/private다. production/public bind에서 Paper 대시보드 활성화를 거부한다. 이 경계는 소유자 인증의 대체물이 아니며 외부 배포 전에는 별도 인증·인가가 필요하다.

## 소유자 등록

먼저 `corepack pnpm owner:hash`를 실행해 서버 전용 `.env.owner`를 생성하고 API를 재시작한다. 로그인 전에는 원장을 조회/정지/편집할 수 없다. [등록과 세션 수명](OWNER_AUTH.md)을 따른다.

## 실행 방법

먼저 [Paper worker 데모](PAPER_WORKER.md)의 별도 테스트 DB를 준비한다. 아래는 해당 문서의 포트/계좌를 그대로 사용하는 예시다. 실제 키는 필요하지 않으며 일반 DATABASE_URL을 대체하지 않는다.

```bash
export PAPER_DEMO_DATABASE_URL='postgresql://hth_test:local_test_only@127.0.0.1:55433/hth_readonly_test'
corepack pnpm paper:demo --prepare --account=paper-demo-local --ticks=3
```

API용 별도 터미널에서:

```bash
export PAPER_DEMO_DATABASE_URL='postgresql://hth_test:local_test_only@127.0.0.1:55433/hth_readonly_test'
export PAPER_DEMO_ACCOUNT_ID=paper-demo-local
export PAPER_DASHBOARD_ENABLED=true
export DASHBOARD_ENABLED=false
corepack pnpm dev
```

`http://127.0.0.1:5173/paper`를 연다. 기존 dev 서버가 있다면 새 설정을 반영해 재시작해야 한다. 이 설정 자체는 거래를 재개하지 않는다. 별도 worker 터미널에서 `paper:demo --account=paper-demo-local --resume`을 실행해야 모의 거래가 진행된다. 키가 들어 있는 기존 `.env`를 변경할 필요는 없다. 환경변수 true/false는 API와 broker 조회를 각각 독립 제어한다.

브라우저는 2초 간격으로 조회하며 비활성 상태에서는 자동 조회를 멈춘다. 새로고침으로 다시 확인할 수 있다. Vercel에는 로컬 API 프록시가 없고 이 기능을 연결/배포하지 않는다.

## 검증과 다음 단계

가짜 서비스 API 테스트로 기본 비활성·외부 접근/CSRF 차단·설정 검증·입력 주입 거부·정지 응답·원본 오류 제거를 확인한다. 전용 임시 DB 테스트로 부분 체결 후 현금/예약/손익 일치·내부 정보 제거·계좌 범위·50개 제한·stale/만료 표시·조회 무변경·writer 행 잠금을 기다리지 않는 snapshot 조회를 검증한다. 기존 worker/리스크/체결/백테스트 테스트도 함께 실행한다. 브라우저에서 합성 데이터 표시와 정지 → worker lease 해제·보유분 유지도 확인했다.

소유자 인증·전략 설정의 영속 revision 관리와 활성 제어도 구현했다. 실제 시세 source의 CLI와 계좌 출처/화면 연결도 추가했다. 다음은 휴장 대기·일일 기준 검토 절차와 장시간 실데이터 관측 검증이다. 실제 broker 주문은 별도 단계다.

## 실제 시세 계좌 연결과 기존 계좌 업그레이드

먼저 [실제 시세 Paper CLI](PAPER_MARKET_SOURCE.md)에서 별도 모의 계좌를 생성한다. API 서버에서 다음을 명시하고 재시작하면 같은 `/paper` 화면이 해당 DB의 출처와 데이터를 표시한다. 웹에 증권사 키나 DB URL을 넘기지 않는다.

```bash
export PAPER_DASHBOARD_ENABLED=true
export PAPER_DASHBOARD_KIND=market
export PAPER_MARKET_DATABASE_URL='postgresql://hth_test:local_test_only@127.0.0.1:55434/hth_readonly_test'
export PAPER_MARKET_ACCOUNT_ID=paper-market-local
corepack pnpm dev
```

DB 출처가 서버 설정과 반대이면 조회를 차단한다. DTO 상위/스냅샷 출처도 일치해야 한다. 실제 시세 계좌에서는 KR/US 편집과 장기 기간 최대 199를 허용한다. 합성 계좌는 KR만 허용한다. 출처 위반 편집은 서버에서도 거부한다. 브라우저로 source나 계좌를 바꾸거나 worker를 시작하지 않는다.

마이그레이션 `0006_complete_molecule_man.sql`은 과거 계좌를 출처 미확인·정지/새 epoch로 전환하고 정지 이력을 남긴다. 현금·보유분·원가·손실·체결 이력을 덮어쓰지 않는다. ID 이름이나 기존 시세 태그만으로 출처를 소급 추정하지 않는다. 미확인 계좌는 조회/긴급 정지는 가능하지만 편집·lease 획득·새 의도/체결은 거부한다. 이 계좌는 출처를 수정해 재사용하지 않고 이력으로 보존한다. 새 출처가 명시된 별도 계좌를 만들어 검증하며 기존 자산을 자동 이관하지 않는다. 남아 있는 예약은 자동으로 해소된 것으로 표시하지 않는다.

API는 마이그레이션을 실행하지 않는다. 변경을 반영하기 전 전용 테스트 DB에서 `paper:demo --prepare` 또는 `paper:market --prepare` 절차를 사용한다. 일반 사용자 DB를 대상으로 이 CLI를 실행하지 않는다. 새 source 필드가 없는 DB는 조회 실패로 표시하며 합성으로 fallback하지 않는다.
