# Trading domain

순수 전략 계약과 시장 데이터 종료·신선도 검증을 제공한다.

`assessCandle`은 세션·대기·재관측 증거로 종료 봉을 판정한다. `prepareStrategyData`는 최신성·계좌·환율·시장 상태를 검사하고 조건 실패 시 빈 입력 목록을 반환한다. broker와 DB를 import하지 않으며 외부 I/O와 시계는 worker가 주입한다. 정책과 한계는 `docs/MARKET_DATA_POLICY.md`를 따른다. 실제 전략 계산·리스크 판단·주문 실행·백테스트는 아직 없다.
