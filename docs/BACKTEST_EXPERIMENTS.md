# 동결 파일 기반 백테스트 비교

`backtest:experiment`는 여러 기간의 동결 파일과 이동평균/비용 설정을 조합해 실행하는 오프라인 CLI다. broker·토큰·계좌·DB 연결과 마이그레이션을 사용하지 않는다. 서버 `.env`도 로드하지 않으며 `TRADING_MODE=paper` 기본값만 허용한다. 새 의존성은 추가하지 않고 기존 Zod 계약, 백테스트 엔진, SHA-256 함수를 재사용한다.

## 실행

저장소 루트에서 실행한다. manifest와 결과 경로는 worker 실행 디렉터리를 기준으로 해석하므로 절대 경로를 사용하면 명확하다.

```bash
corepack pnpm backtest:experiment --manifest="$PWD/.local-data/experiment/manifest.json" --output="$PWD/.local-data/experiment/result.json"
```

manifest 예시는 다음과 같다. `contentHash`의 64자리 0은 실제 동결 파일의 `contentHash`로 교체해야 한다. 경로는 **manifest가 있는 디렉터리 기준**이며 기존 파일의 `{ id, contentHash, dataset }` schema/hash를 다시 검증한다. DB에서 export하거나 `data:backfill --output`으로 보관한 파일을 사용할 수 있다.

```json
{
  "formatVersion": "backtest-experiment-v1",
  "datasets": [
    {
      "id": "research-period",
      "path": "dataset.json",
      "contentHash": "0000000000000000000000000000000000000000000000000000000000000000",
      "role": "research"
    }
  ],
  "variants": [
    {
      "id": "ma-5-20-base",
      "config": {
        "strategy": { "fastPeriod": 5, "slowPeriod": 20 },
        "execution": {
          "initialCash": "1000",
          "quantity": "1",
          "priceTick": "0.01",
          "buyFeeBps": "10",
          "sellFeeBps": "30",
          "sellTaxBps": "0",
          "slippageBps": "5"
        }
      }
    }
  ]
}
```

위 비용/자금은 미국 달러 입력을 위한 모의 예시이며 실제 요율이나 투자 권고가 아니다. 다른 이동평균·비용 조건을 `variants`에 추가하고, 별도 기간의 동결 파일을 `datasets`에 추가한다. 단순히 같은 파일의 role을 바꾸는 방식으로 검증 기간을 만들지 않는다. 원본 파일을 잘라서 기존 종료 판정·커버리지/hash를 재사용하지 말고 별도 요청의 증거를 보존한다.

## 비교 경계

- dataset 최대 8개, variant 최대 8개, 전체 조합 최대 32개다. ID는 각 목록에서 고유해야 한다. manifest는 최대 1MiB, 데이터 파일은 전체 합계 최대 64MiB, 결과 파일은 최대 64MiB다. 전체 조합의 봉 처리량은 최대 100,000개로 실행 전에 제한하고, 각 실행 후 전체 artifact의 누적 직렬화 크기를 검사해 32MiB를 넘으면 다음 결과를 누적하지 않고 실패한다.
- 모든 입력은 같은 종목·통화·interval·adjusted·source여야 한다. 요청 날짜 범위는 양끝을 포함하므로 경계가 같은 날짜도 겹침으로 거부한다. 연구/검증 역할이 달라도 동일하다.
- 각 기간/설정은 독립 초기 자금과 warmup으로 시작한다. 기간 사이 현금·보유분·지표 상태를 이월하지 않는다. 여러 기간의 수익률을 합산하거나 계좌 수익률로 표시하지 않는다.
- `role=research|validation`은 사용자가 선언한 분류다. 과거에 검증 기간을 보지 않았다는 보증이나 자동 최적화 방지가 아니다. 역할을 기록할 뿐 최적 전략·순위·운용 승인·수익성 합격을 생성하지 않는다.
- 기존 다음 체결 가능 시가·정보 가용 시각·비용 모델을 그대로 사용한다. 신호·미체결·미청산·거래 횟수와 비용을 전체 artifact에 보존한다. `tradePathObserved=false`는 체결이 없어 그 경로를 검증하지 못했다는 뜻이다. true도 실제 시세/거래 비용 정확성이나 모든 체결 경로 검증을 뜻하지 않는다.

## 결과와 저장

결과는 manifest hash, dataset ID/hash/요청/역할, 설정/config hash, 각 전체 backtest artifact/report hash, 최상위 result hash를 포함한다. manifest hash는 경로를 포함한 검증된 manifest의 hash이며 결과에는 로컬 경로를 복사하지 않는다. 동일 manifest와 동일 파일을 재실행하면 동일 result hash를 얻는다. 입력 파일의 로컬 UUID가 달라지면 데이터 hash가 같더라도 전체 artifact 식별자가 달라질 수 있다.

파일의 `resultHash`를 제외한 payload에 `contentHash(payload)`를 적용해 확인할 수 있다. 각 `artifact.reportHash`도 해당 hash를 제외한 artifact의 hash다. 입력 schema/hash와 백테스트 증거가 하나라도 불일치하면 전체 실행을 실패시키며 일부 결과를 게시하지 않는다.

새 디렉터리 0700·임시 파일 0600으로 기록·sync 후 hard link로 완성 결과를 게시한다. 기존 결과와 입력 파일을 덮어쓰지 않는다. 기존 부모 디렉터리 권한은 바꾸지 않는다. 실패 시 임시 파일을 정리하며 원본 오류·로컬 경로·인증 값을 로그에 출력하지 않는다. 강제 종료 후 결과가 존재하면 hash를 검증하고 자동 덮어쓰기/재시도를 하지 않는다.

이 비교 파일은 현재 웹의 개별 backtest artifact API와 별도 형식이며 웹에 자동 등록하지 않는다. 합성 파일의 결과는 실제 성과가 아니며 모든 입력은 수집 당시 재현성만 보장하는 `pointInTime=false`다. 더 긴 실제 여러 기간·검증 구간 입력 확보와 비용 가정 검토는 별도 남은 작업이다.

## 저장된 결과 검토

```bash
corepack pnpm backtest:experiment:review --manifest="$PWD/.local-data/experiment/manifest.json" --input="$PWD/.local-data/experiment/result.json" --output="$PWD/.local-data/experiment/review.json"
```

검토는 manifest·결과·개별 artifact의 strict schema와 hash, 조합의 누락/중복, 입력 식별자·역할·설정의 연결을 검사한다. 원본 동결 파일이나 broker/DB 없이 실행하며 입력 파일을 다시 검증하거나 엔진을 재실행하지 않는다. `datasetFilesReverified=false`, `engineReexecuted=false`로 이 경계를 표시한다. 결과에는 기간별 전체 지표와 말기 미체결 수를 보존하고 재개 권한·최적 순위·수익성 승인을 만들지 않는다.

`artifactIntegrityVerified=true`는 체크섬과 내부 연결 검사다. 모든 hash를 다시 계산한 위조나 잘못된 체결 가정·원천 데이터의 진위를 판별하는 서명/공증이 아니다. 입력부터 재현하려면 원본 파일로 `backtest:experiment`를 별도 실행하고 result hash를 비교한다. 조회만으로 해당 재실행을 시작하지 않는다. 검토 출력도 기존 파일 덮어쓰기 금지·private 권한·원자적 게시 규칙을 사용한다.

## 비용 시나리오 자동 대조

현재 검토 출력은 `backtest-experiment-review-v3`이며 기존 rows와 검증 경계를 유지하고 `costComparisons`에 비용 변경 축과 실행 경로 비교를 제공한다. v2는 비용 차이·체결 수 비교까지의 이전 출력으로 보존한다. 원본 실험 결과의 형식과 hash는 변경하지 않는다. 이전 검토 파일은 덮어쓰지 않고 새 경로에 현재 버전 결과를 저장한다.

같은 dataset·역할·전략 파라미터·초기 자금·수량·가격 단위의 조건끼리만 비교한다. 매수 수수료·매도 수수료·매도세·슬리피지 bps가 모두 같거나 높은 방향이고 하나 이상 높을 때 낮은 비용/높은 비용 쌍을 만든다. 이름의 base/stress 문자열로 추정하지 않으며 서로 비용 증감 방향이 섞인 조건과 동일 비용 조건은 쌍을 만들지 않는다.

차이는 **높은 비용 조건 − 낮은 비용 조건**의 십진 문자열이다. 손익 차이와 수수료 차이는 별도로 표시하며 수수료에 세금이나 체결 가격에 반영한 슬리피지가 포함됐다고 해석하지 않는다. 비용 가정은 체결 가능 여부·보유분·이후 신호에도 영향을 줄 수 있으므로 손익 차이를 수수료만의 인과 효과로 표현하지 않는다. 체결 수가 같아도 동일한 체결 경로를 보장하지 않는다. 0체결은 명시하며 손익 차이 0을 비용 내성이나 우수성으로 표시하지 않는다.

각 쌍은 두 variant/report hash와 기간 역할을 보존한다. 여러 기간을 합산하거나 순위·전략 선택·실행 승인을 생성하지 않는다. 이 계산은 schema/hash/조합 관계를 검증한 뒤 수행하며 브라우저·증권사·DB 접속을 추가하지 않는다.

## 비용 변경 축과 실행 경로

`changedCostFields`는 실제 수치가 달라진 비용 필드 목록이다. `10`과 `10.0`의 표기 차이는 변경으로 보지 않는다. 수수료/슬리피지 한 축만 바뀐 비교와 둘 다 바뀐 비교를 식별하되 자동 인과 판정이나 전략 순위로 확대하지 않는다.

`sameFillTimingAndQuantity`는 검증된 리포트의 체결 배열에서 signalIndex·action·timestamp·barTimestamp·quantity가 같은 순서로 일치하는지 검사한다. 체결 가격·대금·수수료·세금은 비용 가정에 따라 바뀌므로 이 비교에서는 제외한다. 체결 건수가 같아도 시각·매수/매도·수량 중 하나가 달라지면 false다. `sameSignalDecisions`는 전체 신호 판단 배열을 비교하며 이유·상태 변화도 숨기지 않는다. 원본 체결/신호 배열은 요약 rows에 복사하지 않는다.

체결 증거가 없거나 체결 배열과 집계 수가 맞지 않으면 체결 경로 비교는 null이다. 양쪽 모두 체결이 0개인 경우도 null로 남겨 관측되지 않은 경로를 같다고 승인하지 않는다. 한쪽만 체결이 있으면 실제 불일치로 false다. 비교 함수는 검증한 내부 자료 전용이며 CLI는 기존 strict schema/hash/조합 검사를 모두 통과한 실제 artifact만 전달한다.

이 결과는 고정 백테스트 모델 안의 실행 경로 비교다. 실제 주문·호가 대기열·슬리피지 정확성·수익성의 검증이나 Paper 실행 권한이 아니다. 조회/검토로 엔진을 재실행하거나 계좌를 변경하지 않는다.
