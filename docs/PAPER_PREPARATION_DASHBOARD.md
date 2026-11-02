# Paper 준비 상태 조회

`/paper`의 **실제 시세 Paper 준비 상태** 패널은 국내·미국 가상 계좌의 초기 준비 기록을 읽는다. 기존 Paper 원장 화면의 서버 고정 계좌/합성·시장 선택을 변경하지 않는다. 두 준비 계좌에 대한 제어·전략 변경·worker 시작·관측·대사·매매 재개·일일 검토 승인 기능은 제공하지 않는다.

## 서버 설정

기본은 비활성이다. 기존 소유자 인증이 설정된 localhost API에서만 별도로 활성화한다. `.env.paper-preparation`은 서버 전용이고 Git/이미지에서 제외한다. dev/start는 기존 `.env`·`.env.owner` 뒤에 이 선택적 파일을 읽는다. 브라우저/VITE 환경변수에 URL·키·계좌 ID를 넣지 않는다.

```dotenv
PAPER_PREPARATION_ENABLED=false
PAPER_PREPARATION_DATABASE_URL=
```

활성화에는 true와 준비 계좌가 있는 localhost/127.0.0.1의 `hth_test` 역할·`hth_readonly_test` DB URL이 필요하다. 로컬 production 컨테이너는 기존 LOCAL_CONTAINER_MODE/loopback 경계에서만 내부 db 주소를 허용한다. 접속 역할/DB identity를 확인하며 스키마가 없다고 마이그레이션하거나 계좌를 만들지 않는다. DB 장애는 패널을 unavailable로 만들며 새 broker 연결로 우회하지 않는다.

고정 대상은 `.local-data/paper-market-local/accounts.json`의 두 시장별 계좌와 계획 hash다. [오프라인 준비](PAPER_OFFLINE_PREPARATION.md)가 만든 서버 파일이며 일반 파일·크기·strict schema·시장/ID 중복을 검사한다. manifest 파일과 대상 디렉터리 symlink는 거부한다. 계획 파일은 서버 고정 `examples/paper-market-kr-validation-v1.json`, `paper-market-us-validation-v1.json`만 읽고 schema·내용 hash·시장 일치를 검증한다. manifest/계획/DB 출처가 다르면 기본값으로 복원하거나 다른 계좌를 찾지 않는다. 로컬 컨테이너로 옮길 때는 이 manifest와 Paper DB를 명시적으로 이관해야 하며 root 로컬 데이터를 자동 복사하지 않는다.

## API와 데이터 경계

소유자 로그인·localhost·Host/Origin 검사를 적용한 `GET /v1/paper/preparation`만 제공한다. query/path/body로 계좌·시장·파일을 선택하지 않는다. query는 빈 strict 계약만 허용한다. 응답은 no-store/private이며 새 DTO의 알 수 없는 필드를 거부한다.

공개 내용은 시장, 준비 검사 결과, 정지 여부, lease 기록 존재 여부, 검토한 가상 자금/한도/전략, DB 조회 시각, KRW/USD별 일일 기준 날짜와 현재 시스템 거래일이다. 계좌 ID·lease token·접속 URL·원본 ledger·전략 revision 원문·감사 details·요청/decision·원본 오류는 제공하지 않는다. lease 기록 존재는 실제 프로세스 실행 중이라는 판정이 아니다. 한도와 자금은 **검토한 계획 값**이며 계좌의 현재 자산/수익률과 혼동하지 않는다.

계좌별 read-only/repeatable-read snapshot에서 계좌·설정·이력·준비 기록·의도/예약/체결 개수를 확인한다. 두 계좌를 하나의 공동 자산 snapshot으로 합산하지 않는다. DB 시각은 snapshot에서 얻고 API의 요청 전후 시각 ±5초를 벗어나면 clock-unverified로 처리한다. 이때 날짜 검토 필요 여부는 null이며 정상/검토 불필요로 표시하지 않는다.

일일 기준 날짜는 KRW·USD 모두 비교한다. 미국은 기존 뉴욕 20시 거래일 모델을 사용한다. 초기 준비 검사가 일치해도 날짜 변경 검토·실제 시장 입력 검증·거래 권한은 별개다. 정상 응답의 ready는 조회 성공이며 `canResume=false`, `marketReadiness=not-checked`, `executionEnabled=false`다. 이미 관측/변경/매매한 계좌의 초기 준비 불일치를 숨기거나 초기 상태로 되돌리지 않는다.

API는 worker의 **읽기 전용 공개 순수 함수 모듈**만 사용한다. 원래 CLI의 apply/migrate 실행 함수를 API에 노출하지 않는다. 새 endpoint는 broker·토큰·source·worker를 생성하지 않는다. 이 공개 모듈의 빌드가 필요하므로 root test/typecheck는 공통 패키지 뒤 worker 산출물을 먼저 만든다.

## 화면과 실패 처리

Paper page 내부 패널과 TanStack Query를 사용하며 10초마다 조회한다. 다른 page/slice를 직접 참조하지 않는다. 조회 오류 또는 30초 넘은 캐시는 준비 정상으로 표시하지 않고, DB/파일 검증 실패는 unavailable로 표시한다. 세션 만료는 기존 인증 이벤트와 캐시 취소/삭제를 따른다. 별도 새 의존성은 추가하지 않았다.

2026-11-02 로컬 준비 DB에 연결해 양 시장 설정 일치·정지·날짜 검토 필요를 확인하고, 조회 전후 계좌/설정/이력/주문 상태가 같음을 검증했다. 기존 Paper 원장 DB·broker 토큰 잠금·진행 중 국내 관측을 변경하지 않았다. 개발 API 재시작 후 기존 소유자 비밀번호로 다시 로그인하면 `/paper`에서 확인할 수 있다.

## 검증

API 테스트는 공개 DTO의 비공개 정보 제거, 서버 고정 대상, hash 불일치, source 불일치, 중복 manifest·symlink·파일 크기 거부, 미확인 시각, 기본 비활성, 인증/localhost/입력 경계를 확인한다. 화면 테스트는 설정 일치와 날짜 검토 필요 동시 표시, 오류/만료 캐시 숨김, 미확인 DB 시각을 검증한다. 원장 읽기 검증과 운영 설정/화면 검증을 실제 시장 전략/체결 검증으로 표현하지 않는다.

전체 회귀 검사에서 발견한 기존 달러 체결 테스트 문제는 DST 종료일의 합성 세션이 25시간이 된 원인이었다. 운영 세션 길이 검증은 유지하고 합성 fixture에서 현재 시각을 포함하는 24시간 미만 창을 사용하도록 수정했다. DST 시작/종료일 첫·마지막 시간 회귀 테스트를 추가했다. 실제 증권사 캘린더나 매매 정책을 바꾸지 않았다.

전체 442개 테스트를 별도 임시 PostgreSQL/단일 worker에서 통과했고 타입·린트·빌드·포맷 검사를 통과했다. 실제 준비 DB의 공개 projection이 두 계좌 모두 설정 일치·정지·날짜 검토 필요를 반환하고 조회 전후 원장/전략/이력이 바뀌지 않는 것을 확인했다. 개발 서버 재시작 뒤 웹/API HTTP 200·미로그인 준비 endpoint HTTP 401을 확인했다. 서버 전용 DB URL/비밀번호가 웹 빌드에 포함되지 않고 설정 파일이 Git 제외 대상인 것도 확인했다. 브라우저 로그인 후의 실제 화면은 기존 소유자 비밀번호로 확인한다.
