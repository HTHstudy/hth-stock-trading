# 권한 폐기 증거의 확보 가능성 검토

확인일: 2026-11-10. [정책 설계안](PAPER_AUTHORITY_FENCING_DESIGN.md)의 후속 조사다. 공개 공식 자료와 추적 중인 코드/설정만 확인했다. 실제 host·예약·DB·자격 목록은 수집하지 않았으며, 환경파일·원본 예약·계좌 자료도 읽지 않았다. 아래는 **증거 수집의 가능성과 부족한 조건**이며 실제 폐기 확인서가 아니다.

## 결론

현재 자료만으로 세 경계 전체를 검증한 실환경 판정을 만들 수 없다. DB에는 공식 조회/통제 수단이 있지만 실제 범위·권한·세션을 확인하지 않았다. 실행 환경에는 전체 구실행/재기동 범위와 새 비밀값의 격리 근거가 필요하다. Toss는 이전 토큰 무효화와 WS 종료를 설명하지만, 키/클라이언트 전체 회수의 범위·효력 시각을 확정할 공개 보장은 이번에도 찾지 못했다.

따라서 실제 collector·정책 적용·예약 예외는 아직 연결하지 않는다. 기존 a407 차단을 유지하며, 이번에는 그 원본이나 현재 DB 상태를 재감사하지 않았다. `canResume=false`이며 관측/Paper 실행·실주문 권한을 부여하지 않는다. [합성 검증기](PAPER_AUTHORITY_FENCING_SIMULATION.md)의 통과나 입력 hash도 이 부족분을 채우지 못한다.

## 11개 조건별 수집 경로

아래 이름은 합성 검증기의 조건과 대응한다. 실제 증거를 그 synthetic-fixture 계약으로 받겠다는 뜻이 아니다. 모든 행은 실환경 미검증이다.

| 경계/조건                          | 향후 확인할 원천과 주체                                            | 수집 가능성·남은 조건                                                                                                          |
| ---------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| runtime / launchDenied             | 전체 대상 OS/컨테이너 관리 계층의 실행 제한·워크로드 상태          | 관리 계층 식별부터 필요. PID 없음이나 소유 자식의 exit 하나는 전체 범위를 증명하지 않음                                        |
| runtime / autostartDenied          | host 예약/서비스 관리자와 Docker 재기동·재생성 경로                | 알려진 Compose 정책 조회는 가능하나 저장소 밖 예약·다른 daemon/host·복사본 범위는 미확인                                       |
| runtime / newSecretAccessDenied    | 별도 관리 주체의 UID/ACL·마운트·비밀값 공급 경계                   | 기존 실행과 같은 UID/읽기 경로에 새 비밀값을 두는 방식은 채택 불가. 별도 디렉터리 이름이나 0600만으로 격리했다고 판단하지 않음 |
| database / newConnectionsDenied    | PostgreSQL 관리 연결의 역할·권한·인증 경로와 승인된 부정 접속 검사 | 공식 기능 있음. Paper DB와 토큰 잠금 DB의 실제 대상·모든 구접속 경로를 먼저 고정해야 함                                        |
| database / existingSessionsGone    | 충분한 가시성을 가진 관리 연결의 pg_stat_activity                  | 공식 조회 있음. 활성 쿼리뿐 아니라 idle/idle in transaction도 포함하고 일회 조회를 지속 차단으로 확대하지 않음                 |
| database / transactionsSettled     | 관리 연결의 세션 상태·pg_prepared_xacts와 전후 원장 비교           | 세션 0만으로 2단계 커밋 대기 트랜잭션까지 없다고 판단하지 않음. 존재하면 자동 commit/rollback 없이 차단                        |
| database / alternateAccessDenied   | 역할 속성·membership/SET ROLE·PUBLIC/소유권·인증/네트워크 경로     | 공식 조사 수단 있음. 구환경의 관리자 접속·대체 역할·공유 자격 노출을 제외할 실제 범위는 미확인                                 |
| broker / newTokenIssuanceDenied    | Toss의 키/클라이언트 관리 통제와 해당 범위의 공식 보장             | 공개 REST Auth operation에서 회수 API를 확인하지 못함. WTS 관리 기능의 부재로 단정하지 않음                                    |
| broker / existingTokensDenied      | 제공자 회수 보장·효력 시각과 승인된 토큰 검증 결과                 | 새 발급이 직전 토큰을 무효화하는 정책은 확인. 구 client의 재발급 권한 폐기와 별개                                              |
| broker / existingConnectionsDenied | 제공자 WS 회수 정책·효력 범위와 승인된 연결 종료 검증              | 무효화/IP 제외 시 auth-revoked 후 종료 정책은 확인. 모든 구연결을 포괄하는 관리 작업/최대 지연은 미확인                        |
| broker / providerScopeKnown        | 제공자의 client·키·계정·토큰·연결 범위 설명과 관리 작업 기록       | FAQ나 한 번의 401/403만으로 전체 범위·원인을 확정할 수 없음. 공급자 확인 필요                                                  |

새 접속/토큰 검사 자체도 활동이다. 현재 이번 조사에서 실행하지 않았고, timeout·네트워크 오류·오입력에 의한 실패를 폐기 성공으로 분류하지 않는다. 성공하는 재발급 검사는 기존 token owner의 토큰을 무효화할 수 있으므로 단순 조회처럼 자동 실행하지 않는다.

## 현재 저장소에서 확인한 경계

- [로컬 Compose](../infra/compose.local.yml)는 api/worker에 동일 UID 1000, app_data·IPC 볼륨과 같은 설정 변수의 DB 비밀번호를 제공한다. Toss 설정도 두 서비스 환경에 선언돼 있다. 이는 추적된 템플릿 사실이며 실제 값/활성화/배포 상태는 확인하지 않았다. 이 구조 자체는 구실행으로부터 새 secret을 격리했다는 증거가 아니다. 운영 구조를 이번에 바꾸지 않는다.
- 같은 Compose는 `unless-stopped`를 사용한다. 수동 중지한 컨테이너의 재시작 정책과, 다른 관리자가 다시 start/Compose 재생성을 할 수 있는 권한은 별개다. Docker daemon 제어 권한도 관리 범위에 포함해야 한다. [공식 재시작 정책](https://docs.docker.com/engine/containers/start-containers-automatically/), [공식 daemon 보안 경계](https://docs.docker.com/engine/security/)
- [Paper DB 초기화](../infra/init-paper-db.sh)는 새 hth_test를 비관리 역할로 만들지만 그 역할은 Paper DB 소유자다. 기존 역할/인증·membership 전체를 감사하거나 비밀번호를 회전시키는 도구가 아니다. “초기화 스크립트가 있다”를 현재 우회 권한 부재의 증거로 쓰지 않는다.
- [DB 검증](../packages/database/src/test-database.ts)은 localhost·hth_readonly_test·hth_test를 고정하고, [checkpoint](../packages/database/src/paper-review.ts)는 계좌/source·host·port·DB·role에 연결된다. 별도 역할/주소로 이전하면 기존 scope와 달라지므로 검증을 느슨하게 하거나 hash를 다시 써서 연결하지 않는다. 이전이 필요하면 보존 원장을 대상으로 한 별도 scope 연결 설계가 선행한다.
- [소유 실행 래퍼](../apps/worker/src/owned-paper-validation.ts)는 직접 시작한 자식의 종료를 기록한다. 과거 소유하지 않았던 실행·다른 host/예약·자격의 전체 범위까지 소급 인증하지 않는다.

이는 파일 대조에 근거한 설계 판단이다. OS 프로세스/예약·Docker 실제 설정·DB catalog·Toss 계정에 대한 실환경 감사 결과는 아니다.

## 공식 DB 자료가 보장하는 범위

CONNECT는 연결 시작 때 검사된다. 기존 세션의 사용 중단은 별도로 검증해야 한다. PUBLIC 기본 권한과 역할/소유권도 함께 검토한다. 비밀번호 변경이나 역할 한 개의 직접 grant 제거만으로 전체 접속 경로를 닫았다고 판단하지 않는다. [PostgreSQL 17 권한](https://www.postgresql.org/docs/17/ddl-priv.html), [역할 속성](https://www.postgresql.org/docs/17/role-attributes.html)

pg_stat_activity는 서버 활동을 제공하지만 조회 권한·트랜잭션 내 snapshot 캐시를 고려해야 한다. 조회가 불완전하거나 오래됐으면 미검증이다. 세션 종료 함수의 timeout 없는 true는 종료 신호 전송일 수 있으므로 실제 종료/대사와 구분한다. [활동 조회](https://www.postgresql.org/docs/17/monitoring-stats.html), [세션 제어](https://www.postgresql.org/docs/17/functions-admin.html#FUNCTIONS-ADMIN-SIGNAL)

PREPARE TRANSACTION 이후에는 그 트랜잭션이 세션과 분리될 수 있다. pg_prepared_xacts의 별도 확인이 필요한 이유다. 검사 중 발견했다고 임의로 정리하지 않는다. [준비 트랜잭션](https://www.postgresql.org/docs/17/sql-prepare-transaction.html), [준비 상태 조회](https://www.postgresql.org/docs/17/view-pg-prepared-xacts.html)

## Toss에 확인할 질문 초안 — 미발송

계좌 번호·키·토큰을 넣지 않은 지원 문의 초안이다. 실제 문의는 보내지 않았다. 답변은 기능 지원 확인이며 해당 계정의 실제 적용/효력 검증을 대신하지 않는다.

1. WTS Open API 키 재발급/삭제/비활성화 각각이 이전 client_id·client_secret의 새 토큰 발급을 차단하는가? 영향을 받는 client/계정 범위는 무엇인가?
2. 위 작업이 이미 발급된 모든 access token을 무효화하는가? 발급과 회수가 경합하거나 기존 요청이 처리 중이면 적용 기준 시각과 최대 지연은 무엇인가?
3. 기존 WebSocket 연결도 모두 종료되는가? auth-revoked·연결 종료의 최대 지연과 실패/부분 적용을 확인하는 공식 방법이 있는가?
4. 허용 IP 제외가 토큰 발급·기존 토큰 REST 사용·기존 WS에 각각 미치는 범위와 지연은 무엇인가? 이후 IP 재등록 시 옛 키/토큰의 권한이 되살아나는가?
5. 관리 작업 대상·성공/부분 실패·효력 시각을 확인할 관리 이력이나 공식 receipt/조회 방법이 있는가? 공개 명세 외 지원되는 관리 절차가 있는가?
6. 키/클라이언트 전체 회수가 보장되지 않는다면, 구발급 자격·기존 토큰·기존 연결을 함께 차단하는 공식 권장 절차와 보장 범위는 무엇인가?

공개 문서는 이번에도 메모리에서 GET 조회했다. REST 1.2.28·AsyncAPI 1.2.3 및 FAQ/overview의 바이트 hash는 [같은 날의 확인 기록](TOSS_API.md#2026-11-10-구실행-권한-폐기-설계의-공개-명세-확인)과 네 문서 모두 같았다. Auth operation은 POST /oauth2/token 하나였다. WS의 토큰 삭제/무효화 서술에서 실제 삭제 endpoint나 관리 작업의 전체 효력을 추론하지 않는다. [공식 REST](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json), [공식 WS](https://openapi.tossinvest.com/openapi-docs/latest/asyncapi.json), [FAQ](https://openapi.tossinvest.com/openapi-docs/faq.md), [연동 가이드](https://openapi.tossinvest.com/openapi-docs/overview.md)

## 실제 수집기를 만들기 전의 계약

- 수집자는 구워크로드와 구분된 통제 주체여야 한다. 관리 연결/관리 채널의 인증과 접근 경계를 먼저 정한다. 같은 쓰기 주체의 자체 JSON·자체 서명이나 UI의 수동 확인 버튼을 외부 증거로 받지 않는다.
- 승인 계획/기준 hash·scope·구/신 generation·정책/수집기 revision·원천 대상·효력/캡처/만료 시각을 연결한다. 원천의 진위를 확인한 뒤에만 최소 결과를 만들며 content hash는 그 연결만 담당한다. 소유자 인증은 웹 접근 제어이지 제공자 증거 인증이 아니다.
- runtime·DB·broker의 실제 식별자는 서버의 비공개 범위 자료에서만 연결한다. 키·토큰·URL·계좌·PID·쿼리 본문·원본 관리 출력은 공개 DTO/일반 로그/커밋에 넣지 않는다. 출처를 숨긴 `confirmed` 요약만으로 성공시키지 않는다.
- 수집 중 범위/기준 변경, 시계 역행, 통제 철회·관리 채널 단절은 차단이다. 과거 receipt만으로 현재 통제가 계속 살아 있다고 판단하지 않는다. 다중 시스템을 단일 원자적 snapshot으로 간주하지 않는다.
- 실제 증거용 계약과 인증/재검증 수명은 별도로 검토한다. 현행 합성 CLI에 `--input`, `--apply`, DB/관리 접속이나 실환경 success 모드를 추가하지 않는다.

## 다음 작업과 의존 관계

| 순서 | 작업                                           | 병렬 가능 여부·완료 조건                                                                                              |
| ---- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| A    | 일회용 전용 DB의 검증 실험 설계/구현           | B/C와 병렬 가능. 실제 자격 없이 신규 접속 차단/기존 세션/트랜잭션/대체 경로를 재현. 실험 결과를 운영 증거로 쓰지 않음 |
| B    | 관리 대상 범위·새 secret 격리 방식 설계        | A/C와 병렬 가능. host·daemon·예약·복사본·DB·client의 범위와 통제 주체를 명시. 실제 환경 목록 수집/변경은 별도 작업    |
| C    | 위 공급자 질문의 공식 답변/추가 공개 근거 확보 | A/B와 병렬 가능. 답변을 기다리는 동안 A/B 개발 가능. 답변 없이 자동 회수 API를 추측하지 않음                          |
| D    | 실제 증거 계약·관리 전환/지속 통제 설계        | A/B/C에서 해결된 범위에 의존. 미해결 경계가 있으면 적용 불가를 유지                                                   |
| E    | 별도 승인된 관리 작업·실제 효력 검증           | D 이후. 이번 조사나 합성 통과로 승인하지 않음. 완료돼도 정지 인계이며 Paper/실거래 자동 재개 없음                     |

현재 바로 가능한 개발은 A/B다. 공급자 보장 미확인이 모든 개발을 멈추게 하지는 않지만, 실환경 정책 적용의 필수 조건은 남는다. 이번 완료 범위는 조사·수집 경로·문의 초안·후속 작업 확정이다. 코드·의존성·DB·원본/계좌·예약·실행 상태는 변경하지 않았다.
