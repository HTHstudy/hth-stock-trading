# Paper 실행·복구 worker

## 현재 범위

`apps/worker/src/paper-worker.ts`는 Paper 원장과 주입한 읽기 전용 데이터 source를 조립한다. 이동평균 교차의 신호 → 의도 선기록 → 리스크 예약 → 다음 관측의 모의 체결을 실행한다. 원장은 [Paper 원장](PAPER_LEDGER.md), 가격·비용 모델은 [Paper 체결](PAPER_FILLS.md)을 따른다. 새 외부 라이브러리·Redis·작업 큐는 추가하지 않았다.

실행 가능한 `paper:demo`는 **합성 KR 데이터 + 전용 테스트 DB**로만 동작한다. 실제 계좌·토스 시세·주문 API를 연결하지 않는다. 기본 worker/dev/start는 여전히 대기 모드이며 키 설정으로 실행 루프가 활성화되지 않는다. [로컬 합성 Paper 조회·정지 화면](PAPER_DASHBOARD.md)을 추가했다. 실제 시세 source·외부 배포용 인증·Docker 자동 실행은 후속이다. `executionEnabled=false`는 broker 실행이 없다는 의미이며 모의 원장에는 변경이 생길 수 있다.

## 실행 수명과 권한

1. 설정은 Zod로 검사한다. 계좌는 미리 초기화되어야 하고, 지정한 전략 ID의 DB 활성 상태·구현 버전이 일치해야 한다. 현재 runtime 구성은 이동평균 교차용이다. 다른 전략의 pure interface는 유지하며 runtime 등록 기능은 후속이다.
2. 계좌별 30초 lease를 얻으면 정지·복구 필요 상태가 된다. 반환된 token/epoch에 묶어 `recoverLease`로 열린 Paper 의도의 잔량을 원자적으로 중단한다. 이미 체결한 수량·원가·현금은 보존한다. 다른 worker가 소유하고 있으면 시작을 거부하며 그 worker를 정지시키지 않는다.
3. configured 종목과 모든 보유 종목의 quote를 읽어 `observe`로 평가한다. 같은 거래일 손실은 재시작해도 보존한다. 기본 resume=false이므로 관측만 하며 주문 의도/체결을 만들지 않는다. 명시적 resume=true일 때만 복구·현재 version을 재검사하고 재개한다. 정지 epoch가 도중 바뀌면 재개하지 않는다.
4. 비동기 tick 하나를 완료한 뒤 다음 interval을 기다린다. 동시에 두 tick을 실행하지 않는다. 별도 5초 heartbeat가 lease를 갱신하며 heartbeat 자체도 겹쳐 실행하지 않는다. lease 상실·DB 오류·수집 timeout/오류·오래된 데이터·미확인 주문은 실행을 중단한다.
5. 종료 요청은 데이터 source에 AbortSignal을 전달한다. 진행 중인 tick/초기화·heartbeat를 정리한 후, 같은 token을 가진 경우에만 잔여 의도를 중단하고 정지·lease 해제를 커밋한다. 이미 다른 worker가 인수했다면 그 계좌의 제어·예약을 건드리지 않는다. DB 자체가 불가용하면 해제를 보장할 수 없으며 lease 만료와 다음 소유자의 복구로 처리한다.

`run(signal, onTick, ticks)`는 지속 실행/유한 검증을 제공한다. `start/step/close`는 같은 실행기를 단계별로 검증하는 API다. close는 여러 번 호출해도 한 번만 정리한다. raw 오류·계좌·token·잔고를 로그에 출력하지 않는다. CLI 출력은 합성 source 표시, 실행/정지 상태, 해당 tick의 신호·체결 건수뿐이다.

## tick 처리와 중복 방지

- source에는 필요한 종목 목록과 AbortSignal만 전달한다. 반환된 evidence는 엄격한 Zod 계약·종목 집합·중복·health 검사 후 사용한다. timeout이 지나면 새 작업을 진행하지 않는다. 실제 source를 붙일 때도 취소를 구현해야 한다.
- 보유분 quote로 평가를 갱신하고 현재 제어 epoch를 다시 확인한다. 데이터 준비 검사는 기존 `prepareStrategyData`를 사용한다. MARKET_CLOSED만 있는 경우 해당 전략을 건너뛰며 다른 데이터 오류가 있으면 정지한다. 실제 휴장 시간의 관측/수집 정책은 실제 source 연결 시 검증해야 한다.
- 기존 의도가 만료되면 현재 token/epoch로 잔량만 중단한다. 유효한 예약은 설정한 maxFillQuantity 이내의 한 부분 체결만 처리한다. 새 신호의 예약은 그 tick에서 체결하지 않는다. 다음 관측도 예약 검사 시각보다 새로운 quote여야 한다.
- 전략에는 준비된 종료 봉과 자기 소유 수량만 전달한다. 원장·broker를 직접 전달하지 않는다. 매도 수량은 자기 소유분과 설정 주문 수량 중 작은 값이다.
- 의도 ID는 전략·시장/종목·방향·버전·봉 출처의 결정적 hash다. 같은 봉의 기존 의도가 있으면 종료/거부/부분 체결 여부와 관계없이 다시 생성하지 않는다. 체결 ID는 의도와 기존 누적 체결량의 hash다. 불확실한 DB 응답을 새 ID로 재시도하지 않고 worker를 정지시킨다. 다음 소유자는 DB에 실제 커밋된 기록을 기준으로 복구한다.

설정은 신뢰된 서버 입력이다. 전략 파라미터의 영속 버전 관리·사용자 편집·설정 hash와 활성화 UI는 아직 없다. 변경 시 명시적으로 중단·재시작/재개해야 하며 같은 봉 재평가를 자동 허용하지 않는다.

## 관측과 거래일

`observe(accountId, token, epoch, { quotes, sourcesHealthy: true, hasUnknownOrders: false })`는 계좌 행 잠금 안에서 모든 보유분의 quote 집합·원천/관측 시각·퇴행 여부를 검사한다. 현금·수량·소유권·원가·예약은 변경하지 않는다. 일일 손익은 기존 값에 새 평가자산과 기존 평가자산의 차이만 더한다. 같은 시세를 반복 관측해도 손익은 중복 반영되지 않는다.

시장 거래일은 KR 서울 00:00, US 뉴욕 20:00 경계다. **60초 이내의 연속 관측 중 경계를 통과한 경우** 직전 평가자산을 새 거래일 기준으로 삼고 이번 평가 차이부터 새 일일 손익으로 계산한다. 세션 시가나 실제 broker의 일일 손익 기준을 재현하는 모델은 아니다. 장시간 중단 후 날짜가 바뀌었거나 기존 날짜가 관측일과 다르면 `PAPER_TRADING_DAY_REVIEW_REQUIRED`로 멈춘다. 임의로 손실을 0으로 만들지 않는다. 내부 reconcile로 운영자가 기준을 검토하는 경로는 남겨 두며 자동 재개·보정 CLI는 제공하지 않는다.

## 합성 데모 실행

개발용 별도 PostgreSQL 예시다. 기존 사용자 DB와 분리하며 예시 비밀번호는 테스트 전용이다.

```bash
docker run --rm --detach --name hth-paper-worker-demo \
  --env POSTGRES_USER=hth_test --env POSTGRES_PASSWORD=local_test_only \
  --env POSTGRES_DB=hth_readonly_test --publish 127.0.0.1:55433:5432 postgres:17-alpine
docker exec hth-paper-worker-demo pg_isready -U hth_test -d hth_readonly_test
export PAPER_DEMO_DATABASE_URL='postgresql://hth_test:local_test_only@127.0.0.1:55433/hth_readonly_test'
corepack pnpm paper:demo --prepare --account=paper-demo-local --ticks=3
```

`--prepare`만 명시적으로 테스트 마이그레이션을 적용한다. `@hth/database/testing`은 URL localhost/127.0.0.1·hth_test·hth_readonly_test와 실제 pool URL/DB/role을 검사하고 전용 advisory lock으로 마이그레이션을 직렬화한다. `.env`/DATABASE_URL은 읽지 않는다. 일반 DB 마이그레이션 또는 운영 초기화 API가 아니다.

새 데모 계좌만 KRW 15000/USD 1000과 합성 한도·전략을 초기화한다. 같은 ID의 재실행으로 자금·기존 한도·활성 설정을 덮어쓰지 않는다. 기본 결과는 paused이며 Ctrl+C로 종료할 수 있다. 모의 거래를 명시적으로 재개하고 계속 실행하려면:

```bash
corepack pnpm paper:demo --account=paper-demo-local --resume
```

다른 터미널에서 같은 환경변수를 설정한 뒤 긴급 정지할 수 있다:

```bash
corepack pnpm paper:demo --account=paper-demo-local --stop
```

합성 데이터는 24시간 가짜 KR 세션과 분 단위로 결정되는 가격 패턴이다. 실제 거래일·유동성·투자 성과를 의미하지 않으며 짧은 실행에서 신호가 발생하지 않을 수도 있다. API 키가 필요하지 않다. 검증 후 `docker stop hth-paper-worker-demo`로 예시 컨테이너를 제거한다. 영속 실사용 계좌나 장기 Paper 운용 설정으로 자동 채택하지 않는다.

## 검증과 다음 단계

순수 관측 테스트와 전용 임시 DB의 worker 통합 테스트로 기본 정지, 매수/부분 체결/매도, 재시작 손실 보존, 경합, 긴급 정지, source timeout, 중복 tick 차단, 취소, lease 인수, heartbeat 갱신/실패와 종료를 검사한다. 기존 시장 데이터·백테스트·리스크·원장 테스트도 함께 실행한다. 실제 증권사 API는 호출하지 않는다.

Paper 전용 조회 API와 실행 상태·의도/체결·실패 이력·긴급 정지 화면을 localhost/테스트 DB 범위로 구현했다. 다음은 소유자 인증과 전략 설정 관리다. 이후 소유자 인증, 실제 시세를 읽는 source, KR/US 세션·휴장/일일 기준 정책과 장애 복구를 검증하고 Docker 운영에 연결한다. 실제 broker 주문은 별도 단계다.
