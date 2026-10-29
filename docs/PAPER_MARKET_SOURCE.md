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

## 아직 연결하지 않은 범위

이 변경은 source 구현과 fixture 검증 단계다. 기본 dev·`paper:demo`·대시보드에 실제 시세 source를 연결하거나, broker를 생성/인증하거나, Paper 계좌를 재개하지 않는다. 현재 Paper 화면의 `synthetic-only` 표시는 정확하게 유지한다. 테스트는 가짜 fetch만 사용한다.

다음 작업은 실제 시세 Paper 전용 실행 명령이다. 토큰 단일 소유/advisory lock과 읽기 전용 대시보드 간 경합, 수집 종목 수·페이지 수에 맞는 polling/timeout 예산, 전용 모의 자산 초기화와 실제 계좌 분리, source 출처 저장/표시를 먼저 구현한다. KR/US 휴장 중 평가 시세가 오래됐을 때의 정지/관측 정책, 뉴욕 DST와 일일 손실 경계 및 장시간 중단 후 기준 검토를 검증한 뒤 명시적 실행 절차를 제공한다. Paper 일일 기준은 기존 `PAPER_WORKER.md` 정책을 유지하며 자동 초기화하지 않는다. 실주문·외부 배포는 별도 단계다.
