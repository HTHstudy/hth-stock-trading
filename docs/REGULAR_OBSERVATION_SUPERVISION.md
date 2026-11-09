# 일반 정규장 60표본의 유한 감독과 Paper 선행 증거 연결

일반 정규장 관측을 기존 session/expiry 검증과 분리한 `kind=regular`를 추가한다. 기본은 무접속 미리보기이며 실제 관측·예약·Paper 재개·실주문·마이그레이션은 이번 개발에서 실행하지 않았다. 기존 예약 감사와 자동 재시도 금지는 유지한다.

## 계획과 실행 경계

입력은 세션 시작/종료·시작 시각·기한·관측 간격·기존 예약 창이다. 표본은 60개로 고정한다. 시작 30초·프레임당 10초·관측 완료 뒤 간격·정리 60초를 예산에 포함한다. 시작과 전체 기한이 정규장 안에 있어야 하고 정규장 종료와 같은 기한도 거부한다. 예상 예산이 기한을 넘거나 예약 창과 겹치면 blocked다.

`regularOnly=true`이며 TTL/세션 경계 입력은 받지 않는다. 기존 session/expiry의 출력과 hash는 보존한다. 계획은 시간 예산이며 실제 캘린더·시장 품질·체결 가능성을 검증하지 않는다.

아래 과거 날짜 예시는 **미리보기만** 실행한다. 빌드는 별도로 완료해야 하며 명령은 환경파일·DB·토큰·자식·관측 파일을 만들지 않는다. 날짜가 지났다고 다음 날로 자동 변경하지 않는다.

```bash
node apps/worker/dist/readonly-observation-supervisor-run.js \
  --source=market --symbol=US:AAPL --kind=regular --job-id=us-2026-11-09 \
  --session-start=2026-11-09T14:30:00Z --session-end=2026-11-09T21:00:00Z \
  --start-at=2026-11-09T14:55:00Z --deadline=2026-11-09T16:10:00Z \
  --interval-seconds=60
```

supervisor의 regular 모드는 명시적 job ID가 필수다. 기존 `(kr|us)-YYYY-MM-DD[-retry-N]` 계약·종목 시장·시작 시각의 시장 거래일이 일치해야 한다. ID를 새 요청의 planHash에 포함해 결과까지 연결한다. 다른 종류에서 job/regular 세션 옵션을 섞거나 중복 인자를 전달하면 거부한다.

명시적 실행에는 기존 execute·plan hash·build hash 검증이 추가로 필요하다. 대기 전과 시작 직전의 예약/빌드 검사, 36시간 예약 상한·2분 시작 누락·시계 역행·절대 기한·직접 소유한 자식 하나·취소/정상/강제 종료 구분을 그대로 적용한다. market 자식에는 `--regular-only`를 전달해 새 브로커 캘린더의 정규장/남은 예산을 확인한다. 계획한 세션과 실제 Paper source의 세션 동일성은 실행 직전 별도로 재검증한다.

## 정상 종료에 필요한 증거

- 정상 자식 exit 0·signal 없음·강제 종료 없음과 정리 확인.
- 하나의 관측 UUID, strict manifest/summary·journal hash·60개 전체 표본의 집계/종목/출처/간격/timeout 일치.
- healthy 60, 오류·closed·blocked·시세 역행 0, 전체 표본이 지정 세션 안이며 역행·간격 부족·허용 초과 공백 없음.
- 최종 토큰 계측의 manifest/hash 연결, clockUnverified/limited=false·inFlight=0. 캡처 시각이 미래면 거부.
- 종료 시 빌드와 절대 기한 재검사.

관측 완료는 자연 토큰 갱신·세션 전환·Paper 원장 보존의 완료 판정이 아니다. 관련 기존 false 경계를 유지한다. 미해결 예약이 있으면 자식/새 감독 폴더 생성 전에 차단하며 다른 실행 경로로 우회하지 않는다.

## 새 감독 증거를 Paper에 연결

서버 helper `createSupervisedObservationPrerequisite`만 추가했으며 HTTP endpoint는 만들지 않았다. 고정 `.local-data/readonly-supervisions/<UUID>/`의 request/result와 그 아래 observation/<검증된 관측 UUID>/를 읽는다. request/result 각각 64KiB, token 128KiB, journal은 기존 reader의 32MiB 상한을 사용한다. 일반 파일/O_NOFOLLOW·UUID·상위 디렉터리 symlink·canonical 경로·읽기 전후 identity/바이트를 검사한다. 임의 경로를 브라우저에서 받거나 조회로 파일을 생성하지 않는다.

`verifyRegularSupervisionLink`는 요청에 처음부터 기록된 job ID와 정상 market/regular 감독 결과를 연결한다. 과거 scheduled-observation launch/exit 파일을 추정 복원하는 기능이 아니다. failed/미완료/강제 종료·시각 불확실·다른 시장/거래일·다른 job·demo 자료는 선행 증거로 사용할 수 없다.

helper는 기존 최종 관측 reader로 전체 journal을 다시 읽고 토큰 계측도 재검증한다. 첫 표본부터 마지막까지의 범위·60 healthy·최종 monitoring/공백·종목/출처/시각/manifest와 감독 결과의 journal hash를 대조한다. 최근 50개 표시 자료로 전체 범위를 대신하지 않는다. token은 토큰 문자열이 아닌 원인/결과 계측이며 원본 응답/계좌/비밀값을 반환하지 않는다.

실제 Paper runner에서 감독 자료를 선택할 때는 기존 job ID와 **별도 `--prerequisite-supervision=<UUID>`**를 함께 명시한다. UUID가 잘못되면 I/O 전에 거부한다. 옵션이 없으면 기존 scheduled-observations 경로를 그대로 사용한다. 선택한 감독 자료가 실패해도 기존 job 파일로 fallback하지 않는다. 소유 래퍼는 이 인자를 검증·전달하며 비공개 request에는 supervision UUID만 추가한다. 웹 DTO에는 추가하지 않는다.

두 경로 모두 기존 `verifyPaperPrerequisite`의 60표본·종목·계획 세션·최종 hash·15분 검사를 통과해야 한다. 새 경로는 감독의 세션 시작/종료도 Paper 계획과 대조한다. 재개 직전에 파일을 다시 검증하고 supervisionHash와 관측 evidenceHash가 처음 선택한 값과 같은지 확인한다. 이 조회가 일일 검토·정지 관측·before checkpoint·CAS·실제 재개를 대신하지 않는다.

## 현재 운영 상태와 검증

기존 a407의 독립 종료 근거 부재와 unresolvedCount=1은 그대로다. 새 기능으로 예약 예외·소급 증거·원본 삭제를 만들지 않았다. [기존 실행 후보](PAPER_EXECUTION_CANDIDATE_2026_11_09.md)의 시간 계산은 보존하며 이 구현 완료를 예약/재개 완료로 바꾸지 않는다.

가짜 자식·시계·60표본과 private 임시 파일로 검증한다. 실제 worker verifier → 기존 journal reader → Paper prerequisite guard를 연결하고 종료 후 정확히 15분 허용·15분+1ms 거부를 확인한다. 실패/누락/변조·blocked/공백·파일/디렉터리 교체·symlink·source/시장/시각/job 불일치·원본 보존·legacy hash 보존도 검사한다. 실제 브로커 fetch·계좌·관측 예약·Paper 재개는 테스트하지 않는다. 새 의존성·DB 스키마는 추가하지 않았다.

최종 로컬 전체 검증은 새 일회용 localhost PostgreSQL 17 전용 DB에서 기본 병렬 `verify:ci`로 수행했다. 133파일·1,106개 테스트(57.56초), 포맷·린트·타입·전체 빌드·두 Compose config를 통과했다. 실제 빌드된 CLI의 market/regular 미리보기에서도 60표본·예산 4,230초·scheduled=false를 확인했으며 원격 CI 결과나 실제 관측/재개 증거가 아니다. 테스트용 DB만 정리하고 기존 업무/Paper DB는 보존한다.
