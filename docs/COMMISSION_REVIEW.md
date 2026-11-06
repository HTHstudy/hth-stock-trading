# 수수료 조회와 비용 가정 검토

현재 계좌의 수수료율을 읽고 백테스트에 명시한 수수료 가정과 비교한다. 실제 주문·전략 재개·자동 설정 적용·과거 비용 인증 기능이 아니다. 기존 라이브러리(Zod·decimal.js·원자적 private 파일 저장)를 사용하며 새 의존성은 없다.

## 읽기 전용 조회

```bash
# 기본 미리보기: 키/DB/대상 파일에 접근하지 않는다.
corepack pnpm broker:commissions

# 공개 패키지와 worker를 빌드한 뒤 저장소 루트에서 명시적으로 실행한다.
# .env는 서버에서만 로드하며 출력은 새 JSON 파일이어야 한다.
node --env-file=.env apps/worker/dist/commission-check-run.js --check \
  --output="$PWD/.local-data/commission-checks/new-evidence.json"
```

인증 잠금 DB에서 같은 client의 advisory lock을 획득한 단일 broker만 토큰을 발급한다. 읽는 API는 계좌 목록과 공식 `GET /api/v1/commissions`뿐이다. 계좌가 정확히 하나일 때만 진행하고 0개/여러 개이면 ACCOUNT_SELECTION_REQUIRED로 멈춘다. 기존 계좌를 임의로 선택하지 않으며 계좌 ID를 CLI 인수·파일·로그에 넣지 않는다. 인증 잠금 경합을 새 토큰으로 우회하지 않는다.

확인 모드에만 환경 설정을 검증한다. 알 수 없는/중복 옵션·live·잘못된 출력 확장자를 거부한다. 기본 30초 수명과 SIGINT/TERM 취소를 사용하고 진행 중 조회 정리·broker 수명 취소 후 잠금을 해제한다. DB를 닫은 뒤 새 파일을 게시한다. 실패에 자동 재시도/후속 실행은 없다. 토큰 transport의 기존 제한된 조회 재시도 정책은 유지한다.

저장은 계좌 식별자 없이 market·소수 비율 rate·기간·관측 시각만 남긴 정규화된 private 자료다. 명시적 null과 누락된 날짜를 구분한다. 날짜 필드가 하나라도 누락되면 periodBoundsKnown=false이며 무기한으로 바꾸지 않는다. 중복/겹치는 행을 없애거나 첫 요율만 선택하지 않는다. 신규 디렉터리 0700/파일 0600·원자적 새 생성·기존 파일 덮어쓰기 거부를 적용한다. 기존 부모 권한은 변경하지 않으므로 소유자 전용 private 경로를 사용한다. 원본 계좌 응답·인증키·토큰은 저장하지 않는다.

## 오프라인 비교

```bash
corepack pnpm commission:review
corepack pnpm commission:review \
  --input="$PWD/.local-data/commission-checks/evidence.json" \
  --assumptions="$PWD/.local-data/commission-checks/assumptions.json" \
  --output="$PWD/.local-data/commission-checks/review.json"
```

assumptions.json은 `{ id, market, buyFeeBps, sellFeeBps }` 객체 배열이다. ID는 로컬 실험/리포트 식별자이며 계좌를 넣지 않는다. 최대 100개·ID 고유성·시장·십진 문자열/bps 범위를 검증한다. 입력 파일은 각각 최대 1MiB·일반 파일/O_NOFOLLOW이고 알 수 없는 필드를 거부한다. 이 검토는 broker·키·DB에 연결하지 않고 서버 .env를 자동 로드하지 않는다. 출력에는 report와 내용 hash를 기록하며 기존 결과를 덮어쓰지 않는다.

소수 비율을 정확한 십진 연산으로 10,000배 해 bps와 비교한다. `%` 문자열이나 부동소수점으로 중간 변환하지 않는다. 매수/매도 가정은 별도로 비교하되 API가 매매 방향별 요율을 보장했다고 해석하지 않는다.

| 상태           | 의미                                                           |
| -------------- | -------------------------------------------------------------- |
| available      | 아래 비교 정책에서 신선한 해당 시장의 단일 기간 행을 찾음      |
| stale          | 관측 시각이 미래거나 검토 시각에서 5분 초과                    |
| missing        | 해당 시장의 행 없음                                            |
| period-unknown | 누락된 기간 때문에 적용 범위를 확정할 수 없음                  |
| not-effective  | 비교 날짜를 포함하는 기간 없음                                 |
| ambiguous      | 겹치는/중복된 기간 또는 적용 가능성이 있는 기간 미상 행이 여럿 |

available 외에는 observedCommissionBps와 일치 여부를 null로 남긴다. 누락/만료를 무료 수수료 0으로 바꾸지 않는다. 동일한 여러 행도 중복 근거로 모호하게 처리한다.

기간 비교는 KR/US 모두 KST 날짜의 양끝 포함이라는 **검토용 정책** `kst-inclusive-comparison-v1`이다. 실제 경계 시각/포함 규칙의 검증을 뜻하지 않아 periodBoundaryRulesVerified=false다. `--reviewed-at=<ISO>`로 당시 검토 시각을 명시하면 저장 자료의 비교를 재현할 수 있지만 현재 요율 신선도를 새로 얻는 것은 아니다.

historicalFeesVerified·sideSpecificFeesVerified·taxesVerified·roundingRulesVerified·priceTickVerified·slippageVerified·assumptionsApplied·executionEnabled·canResume는 모두 false다. 현재 응답을 과거 시점의 실제 비용이나 거래 권한으로 확대하지 않는다. 내용 hash는 무결성 비교이며 작성자/원천의 공증이 아니다. [증거 공백](EXECUTION_ASSUMPTION_GAPS.md)을 따른다.

## 2026-11-06 실제 읽기 전용 확인

10:06 KST에 계좌 목록/수수료 조회를 한 번 실행해 시장별 요율 2개를 확인했다. private 증거와 기존 리포트 42개의 가정을 비교했고 당시 비교 정책에서 42개 모두 available이었다. 매수 가정은 14개가 관측 요율과 같았고 매도 가정은 일치가 없었다. 이는 계좌별 방향/정산/과거 요율 검증이나 설정 수정 근거가 아니다. 개인별 실제 요율 값은 이 문서나 로그에 복제하지 않는다.

수집 전후 KR/US Paper 원장 hash가 같았고 실제 주문·전략/한도 변경·재개·시장 데이터 저장·마이그레이션은 없었다. 자료는 `.local-data/commission-checks/c47710a8-0bd7-4a4f-8386-d33244d92e5c/`에 evidence·assumptions·review·verification으로 보관했다. 원래 검토 시각으로 다시 계산한 review-reproduced와 입력/결과 hash를 연결한 reproduction-verification도 별도 파일로 남겼다. 기존 리포트·과거 실행 폴더는 변경하지 않았다. API 조회 성공과 비용 가정의 실제 적합성은 별개다.

테스트는 가짜 fetch와 키/DB 없는 오프라인 fixture만 사용한다. 실제 조회는 자동 테스트와 분리했다. 요율 단위·KST 경계·만료·기간 누락·겹침·잘못된 입력과 preview/live/중복 옵션·출력 보존을 검사한다.

최종 전체 검증은 새 일회용 localhost 전용 DB에서 `verify:ci`의 포맷·린트·타입·통합 포함 840개 테스트·빌드를 통과했다. 첫 로컬 실행의 절전/timeout 실패는 별도로 기록하고 재실행과 구분했다. 임시 DB는 제거하며 운용 DB와 실제 API는 자동 테스트에 사용하지 않았다.
