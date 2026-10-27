# Trading domain

현재는 순수 전략 계약만 제공한다.

실제 구현은 단계별로 `src/market-data`, `src/strategy`, `src/risk`, `src/execution`, `src/backtest`에 추가한다. 전략·리스크·백테스트 계산은 I/O 없이 구현하고 broker·repository 연결은 worker가 조립한다. 현재 전략 계산·리스크 판단·주문 실행·백테스트는 없다.
