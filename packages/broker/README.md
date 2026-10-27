# Broker

현재는 외부 DTO와 분리된 내부 읽기 전용 port만 정의한다. API 요청·인증·토스 adapter·Paper adapter는 구현하지 않았다. 이 인터페이스는 토스 응답 타입을 재현한 것이 아니다.

다음 단계에서 `src/toss` 내부에 공식 명세 기반 Zod DTO, mapper, token manager, 그룹별 limiter를 추가한다. 입력값·응답 fixture로 계약을 검증하고 계좌 참조와 키를 로그에서 제거한다. 종목·시장 캘린더·환율·매수가능금액 port는 해당 데이터 모델 확정 시 추가한다. 주문 port는 이번 범위에서 제공하지 않는다.
