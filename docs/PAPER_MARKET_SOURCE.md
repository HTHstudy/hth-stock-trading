# 실제 시세용 Paper source

## 구현 범위

`apps/worker/src/paper-market-source.ts`의 `createPaperMarketSource`는 주입한 읽기 전용 broker에서 종목·현재가·1분봉·KR/US 캘린더·USD/KRW 환율 유효 기간을 수집하여 기존 `PaperSource` 계약으로 반환한다. 새 endpoint·외부 라이브러리·서비스는 추가하지 않았다. 토스 DTO는 기존 broker adapter에서만 해석한다.

source는 계좌·보유분·매수 가능 금액·주문 메서드를 요구하거나 호출하지 않는다. 실제 계좌의 현금·보유 주식을 Paper 원장으로 가져오지 않는다. `sourcesHealthy=true`는 전체 수집·계약 검증이 완료됐다는 뜻이며 거래 가능 판정이 아니다. `hasUnknownOrders=false`는 내부 Paper 원장 전용이라는 가정이다. 실주문 대사에 사용하지 않는다.

## 데이터와 실패 정책

- 1회 1–20개의 중복 없는 KR/US 종목을 허용한다. 메타데이터·현재가의 누락/중복/다른 종목, 통화 불일치, 다른 시장 캘린더는 수집 실패로 처리한다. 일부 종목만 성공한 결과를 반환하지 않는다.
- 수집 단계 시작 시각을 관측 시각으로 기록한다. 응답이 늦었다고 시세 시각이나 관측 시각을 현재로 덮어쓰지 않는다. 현재가 timestamp가 없으면 null을 유지하여 기존 준비 검사가 차단하도록 한다.
- `collect-candles.ts`는 기존 읽기 전용 snapshot과 공유한다. 종목당 1–5페이지, 페이지당 최대 200봉, 수정주가 미적용으로 요청한다. 같은 시각의 inclusive 페이지 중복은 첫 요청의 값을 보존하고 시간순으로 정렬한다. 페이지 cursor 반복/역행, 다른 종목·통화·간격/수정 여부 혼입은 실패한다.
- 모든 봉을 `isClosed=false`로 반환한다. worker의 `prepareStrategyData`가 원천 시각·관측 시각·세션·대기 기준으로 매번 종료 여부와 신선도를 판정한다. 원천의 종료 플래그나 과거 준비 결과를 실행 승인으로 재사용하지 않는다.
- broker의 KR/US 세션과 휴장 응답을 그대로 전달한다. 합성 세션을 만들거나 DST·휴장을 날짜 산술로 대체하지 않는다. 종목 제한/정지 상태를 보수적으로 전달한다.
- 겹치는 수집은 거부한다. 취소 전·후를 각 조회 단계와 페이지 사이에서 검사하며 취소 후 결과를 폐기하고 후속 요청을 보내지 않는다. 현재 broker 메서드에 호출별 AbortSignal 인자가 없으므로 이미 진행 중인 HTTP 요청을 이 source가 즉시 중단하지는 못한다. 해당 요청은 broker transport의 timeout/재시도 상한을 따르고 worker는 자체 source timeout으로 대기를 중단한다. 수집이 아직 정리되지 않았다면 같은 source를 다시 호출해 중첩하지 않는다.

## 전용 실행 명령

`corepack pnpm paper:market`은 `.env`를 서버에서만 읽는다. `DATABASE_URL`은 기존 broker:check/대시보드와 **같은 토큰 잠금 DB**여야 한다. 별도 `PAPER_MARKET_DATABASE_URL`은 localhost/127.0.0.1의 hth_test 역할·hth_readonly_test DB만 허용한다. 연결 URL의 query/hash는 허용하지 않으며 동일 localhost DB/포트를 두 역할에 지정하면 거부한다. 다른 서버/프록시 주소가 같은 DB를 가리키는지까지 자동 판별하지는 않는다. 전용 DB는 자동매매 설정으로 명시하며 일반 사용자 DB를 모의 원장으로 사용하지 않는다.

```bash
# 기존 사용자 DB·합성 Paper 화면 DB와 다른 개발용 DB
# 예시 비밀번호는 테스트 전용이다.
docker run --rm --detach --name hth-paper-market-local \
  --env POSTGRES_USER=hth_test --env POSTGRES_PASSWORD=local_test_only \
  --env POSTGRES_DB=hth_readonly_test --publish 127.0.0.1:55434:5432 postgres:17-alpine
export PAPER_MARKET_DATABASE_URL='postgresql://hth_test:local_test_only@127.0.0.1:55434/hth_readonly_test'

# 최초 1회: 테스트 마이그레이션·새 가상 계좌·예시 전략을 생성하고 정지 상태로 관측
corepack pnpm paper:market --account=paper-market-local --prepare --initialize --symbol=KR:005930
# US 예시는 별도 새 계좌에 --symbol=US:AAPL

# 기존 계좌: 기본 정지, 1회 관측 후 종료
corepack pnpm paper:market --account=paper-market-local

# 별도 명시적 모의 재개. 10회 tick을 완료하면 다시 정지/lease 해제
corepack pnpm paper:market --account=paper-market-local --resume --ticks=10

# 긴급 정지는 키·토큰 잠금·broker 조회 없이 Paper DB에만 기록
corepack pnpm paper:market --account=paper-market-local --stop
```

키 설정만으로 이 명령이 실행되지 않는다. 기본 dev/start·합성 `paper:demo`와 분리한다. 개발 검증에서는 fixture broker만 사용했으며 위 명령으로 실제 시세 인증·조회·모의 재개를 실행하지 않았다. 실주문 생성·정정·취소 구현은 없다.

### 계좌와 초기화

CLI는 `paper-market-*` 계좌 ID만 허용한다. 합성 CLI/현재 Paper 화면의 `paper-demo-*`와 상호 분리하여 같은 자산 기록에 두 source를 혼용하지 않는다. 계좌의 불변 `data_source`에도 `toss-readonly`를 저장하며 CLI 로그에 같은 출처를 명시한다. DB가 출처 변경·미확인 계좌 재개·다른 출처의 주문 의도를 거부한다. worker lease/관측과 원장 의도/예약/체결에서도 출처를 검사한다. 이 표시는 신뢰된 adapter의 원천 구분이며 가격의 암호학적 진위 증명은 아니다. 관리자에 의한 트리거 비활성화 등 모든 DB 권한 우회를 막는 구조는 아니다. [대시보드](PAPER_DASHBOARD.md)는 서버에서 `market` 종류를 명시해 해당 계좌만 연결하며 합성 계좌와 데이터를 합치지 않는다.

초기 가상 현금은 KRW 1,000,000/USD 1,000, 보유분은 없다. 이동평균 5/20·1주·부분 체결 최대 1주를 예시로 등록한다. 이는 확정 투자 전략이나 검증된 성과가 아니다. 초기 한도는 KRW 주문 100,000/종목 200,000/일손실 10,000, USD 주문 100/종목 200/일손실 10, 최대 5종목이다. 비용은 매수 10bps/매도 30bps의 모의 가정이다. 잔고·한도를 넘는 종목은 리스크 거부될 수 있다.

`--initialize`와 `--resume`의 결합, `--prepare`와 `--resume`의 결합을 거부한다. 기존 ID의 초기화도 거부하며 재실행으로 현금·손실·설정을 덮어쓰지 않는다. 초기화의 계좌 생성/한도/전략 설정은 각각 커밋되므로 중간 실패는 정지된 불완전 계좌를 남길 수 있다. 이 경우 자동 재초기화하지 않으며 실패 단계를 확인해야 한다. 기존 계좌는 저장된 정의/hash를 검사하고 정의 없는 과거 행으로 fallback하지 않는다.

### 실행 예산과 정리

CLI는 최대 5개 전략·전략/보유분을 합친 최대 5종목, 종목당 1분봉 1페이지로 제한한다. 장기 기간+1이 200보다 크면 인증 전에 거부한다. 실제 반환된 유효 종료 봉이 부족하면 전략은 warmup으로 대기한다. tick 완료 후 10초 간격이며, 프레임 전체 수집 timeout은 10초다. 이는 처리 성공 보장이 아니라 중단 상한이다. rate limit·재시도·느린 응답이 예산을 넘으면 중단하며 시세 유효 기간을 늘려 통과시키지 않는다. `--ticks`는 1–1,000,000으로 유한 실행하며 기본 1이다.

전체 실행 동안 기존 client hash의 advisory lock을 보유한다. 같은 client의 읽기 전용 대시보드 새로고침/수집 명령과 동시 실행하면 나중 요청이 잠금 경합으로 실패한다. 다른 DB를 쓰거나 외부 스크립트가 토큰을 발급하면 이 잠금의 보호를 받지 않는다. worker 종료/수집 timeout/오류 시 broker 수명 signal을 취소하고 진행 중 source의 정리까지 기다린 후 잠금을 해제한다. Paper 계좌 lease/미체결 잔량 정리는 기존 worker가 담당한다. SIGINT/SIGTERM도 같은 정리 경로를 사용한다.

## 세션·일일 평가와 검증

KR/US 세션·휴장·DST는 기존 준비 검사를 따른다. 현재 캘린더로 정규장 밖임이 확인되면 오래된 quote로 평가하지 않고 정지·예약 정리 후 대기한다. 캘린더 미확인/만료나 수집 오류는 장애로 종료한다. 보유분 평가에도 신선한 quote를 요구하므로 휴장 중 마지막 체결가를 임의로 현재가로 갱신하지 않는다. KR/US 전략을 한 계좌에 함께 운용할 때도 이 보수적인 정책을 따른다. 자동 재개·장 시작 예약기는 제공하지 않는다.

일일 평가는 서울 00시/뉴욕 20시 모델을 유지한다. DST의 뉴욕 UTC 오프셋과 연속 경계 통과, 장시간 중단 뒤 기준 불일치를 테스트한다. 새 거래일에 오래된 관측이 있으면 손실을 0으로 바꾸지 않고 `PAPER_TRADING_DAY_REVIEW_REQUIRED`로 중단한다. 일일 기준의 명시적 손실 이월 승인은 별도 paper:day-review 명령으로만 제공한다. 임의 금액/가격 재설정 옵션은 없다.

fixture 테스트는 안전한 인자·DB 분리·잠금 선행/경합·기본 정지·명시적 재개·정의 hash·관측 예산·취소 후 잠금 해제 순서를 검증한다. 별도 임시 PostgreSQL에서는 초기화 재실행 보호·기본 정지/주문 없음·지연 시세 재개 실패/lease 해제·긴급 정지를 확인한다. 실제 broker API는 호출하지 않는다.

출처 영속화·변경 방지와 인증된 대시보드 조회/관리를 추가했다. 기존 미확인 계좌는 이력으로 보존하며 출처를 소급 변경하지 않는다. [휴장 대기·일일 기준 검토](PAPER_SESSIONS_REVIEW.md)도 추가했다. 다음 작업은 실데이터로 장시간 관측하는 운영 검증이다. 실주문·외부 배포·Docker 자동 실행은 별도 단계다.

휴장 대기와 장시간 중단 후 손실 기준 검토는 [Paper 세션·검토 절차](PAPER_SESSIONS_REVIEW.md)를 따른다. 개장이나 검토 승인으로 자동 재개하지 않는다.

## 웹 계좌 조회 공유

새 실행의 `--share-dashboard` 옵션으로 같은 broker의 인증·rate limiter를 웹 계좌 조회에도 제공할 수 있다. 이 옵션으로 모의매매가 재개되지는 않는다. 기본 비활성이며 `--stop`과 함께 쓰지 않는다. 공유 요청 정리 후 토큰 잠금을 해제하고, [로컬 IPC와 배포 제약](SHARED_DASHBOARD.md)을 따른다.

초기 가상 자금·한도·전략을 명시적으로 검토하려면 [Paper 검증 계획](PAPER_MARKET_PLAN.md)의 `paper:plan`과 새 계좌 전용 `--plan/--plan-hash`를 사용한다. 기본값과 기존 계좌 설정을 자동 변경하지 않는다.
