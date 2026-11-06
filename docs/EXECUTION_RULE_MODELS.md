# 선택 체결 산술 규칙

백테스트에 명시적으로 선택한 호가·수수료 산술 규칙을 적용한다. 기존 모델을 자동 변경하거나 실제 주문/Paper 실행에 연결하지 않는다. 새 의존성 없이 기존 Zod·decimal.js·전략/데이터 정책을 사용한다.

## 기존 결과와의 구분

`execution.executionRules`를 생략하면 기존 **engineVersion=1.0.0 / next-eligible-open-v1**이다. 파싱 시 기본 profile을 넣지 않으며 기존 config·경고·체결/성과·artifact hash를 유지한다.

규칙을 명시하면 **engineVersion=1.1.0 / next-eligible-open-rules-v1**이고 설정 전체가 report/config hash에 포함된다. report schema는 규칙 유무와 model/version 쌍이 맞아야 한다. 서로 다른 model/version/profile을 비용 bps만 다른 동일 실험으로 묶지 않는다. 기존 리포트는 그대로 남기고 새 결과 파일을 생성한다.

## 입력과 적용 범위

[예제 JSON](../examples/backtest-execution-rules.json)은 엔진 검증용 가정이다. 수수료·세금·가상 자금·MA·거래 장소·상품 분류를 실제 고객/종목의 검증 조건으로 해석하지 않는다.

```bash
corepack pnpm backtest:run \
  --input="$PWD/.local-data/research-expansion/<UUID>/kr-005930-2026-11-02.json" \
  --config="$PWD/examples/backtest-execution-rules.json" \
  --output="$PWD/.local-data/new-rule-report.json"
```

- `priceRule=fixed`: 기존 priceTick을 사용하며 venue/board/assetClass는 unspecified 가정이다. 수수료 산술만 선택할 수도 있다.
- `priceRule=krx-kospi-equity-2023`: **KRW·KR·KRX 유가증권시장 보통주**를 가정한다고 명시해야 한다. 범위 밖 시장·통화·날짜는 UNSUPPORTED_EXECUTION_RULE_SCOPE로 거부한다. 다른 상품/시장으로 자동 대체하지 않는다.
- `venueAssumption=KRX`, `boardAssumption=KOSPI`, `assetClassAssumption=common-stock`은 사용자가 선택한 가정이다. dataset의 종목코드/통합 봉만으로 이를 검증한 것이 아니다. ETF/ETN·우선주·기타 상품·KOSDAQ/NXT/미국 규칙을 구현한 것으로 표시하지 않는다.
- 역사적 시작 근거 2023-01-25와 연구 기준일 2026-11-06을 산술 적용의 보수적 날짜 상한/하한으로 사용한다. 코드의 modeledThrough/researchAsOf는 **전 기간 개정 이력 확인 완료가 아니다**. historicalContinuityVerified=false다. 미래 적용을 자동 연장하지 않는다.

KRX 표·시행일·접근 상태와 NXT 중간가/대량거래가 일반 지정가 표와 다른 경계는 [호가 근거](KR_TICK_RULE_EVIDENCE.md)를 따른다. 통합 봉을 실제 KRX 지정가 체결 원천으로 인증하거나 원본 가격을 표에 맞춰 수정하지 않는다.

## 산술 순서

1. 기존 정보 가용 시각 이후의 다음 적격 시가에 불리한 슬리피지를 적용한다. 신호에 미래 봉을 주거나 같은 봉 종가에 체결하지 않는다.
2. 슬리피지 후 가격의 구간에서 tick을 선택한다. 매수는 올림, 매도는 내림하며 도착 가격도 유효한 구간 단위인지 확인한다. 가격 0은 체결하지 않는다.
3. `buyFee`/`sellFee` 각각의 rounding(ceil/floor)을 통화 단위(KRW 1원/USD 0.01)에 적용한다. 그 다음 minimum을 하한, nullable maximum을 상한으로 제한한다. 최소/최대는 해당 통화 단위의 배수이며 maximum ≥ minimum이어야 한다.
4. 대금이 0이면 비용은 0이다. 양수 대금에서 rate=0이어도 명시한 minimum이 양수면 최소 비용을 적용한다. 면제 조건·최종 환급·주문/일별 합산의 실제 규칙을 암묵적으로 넣지 않는다.
5. 매도세는 기존 명시적 sellTaxBps/통화 최소 단위 올림을 유지한다. 최소/최대 수수료 규칙이 세금에 적용되거나 실제 세율을 검증한 것은 아니다.
6. 매수 대금+비용이 현금을 넘으면 기존 INSUFFICIENT_CASH로 체결을 거부한다. 부족한 자금을 빌리거나 보유분을 자동 청산하지 않는다.

현재는 기존 합성 전량 체결의 각 fill 기준이다. 실제 부분 체결의 비용 합산·최소수수료·청구/환급, 유동성·호가 잔량·시장 충격을 재현한 것이 아니다. [토스 공개 비용 근거](TOSS_FEE_RULE_EVIDENCE.md)는 별도 확인 수준/시행일을 기록하며 그 수치를 preset으로 자동 넣지 않는다.

## 확인한 실험과 이전 결과 보존

기존 국내 005930 11/2~11/4의 동결 입력을 하루씩 독립 실행했다. MA 3/5·5/20 × legacy / fixed-ceil / kospi-ceil / kospi-floor의 8조건을 3일에 적용해 24회 실행했다. 모두 기존 기본 수수료 10/30bps·매도세 별도 0·슬리피지 5bps·1주·초기 10,000,000 KRW 가정이다. 최소/최대 수수료의 별도 산술은 단위 테스트에서 확인하고 이 실데이터 실험은 minimum=0 / maximum=null로 고정했다.

실행 전에 protocol·manifest·컴파일 코드/lockfile fingerprint와 게시 대상을 고정했다. 결과를 두 번 재계산한 hash는 `3f643f79bc59dff1815c2d64346ec10f4a522afcba0084e1e5a9a368455f2776`로 같았다. 기존 국내 base 리포트 6개의 hash가 그대로였고, 미국 기존 12조건 전체 result hash도 보존됐다. fixed-ceil과 기존 모델의 체결·신호·자산 곡선·거래·성과도 같고 구분 메타데이터만 새 모델이다.

아래 순손익은 KRW이며 새 규칙을 가정했을 때의 민감도다. 실제 체결가나 우수 전략 선정으로 해석하지 않는다.

| 날짜 | MA   | 기존 고정 tick | 가격대 tick/올림 | 가격대 tick/내림 |
| ---- | ---- | -------------: | ---------------: | ---------------: |
| 11/2 | 3/5  |        -41,704 |          -70,043 |          -70,002 |
| 11/2 | 5/20 |         -7,619 |          -14,380 |          -14,367 |
| 11/3 | 3/5  |        -47,579 |          -76,094 |          -76,051 |
| 11/3 | 5/20 |        -16,935 |          -25,324 |          -25,314 |
| 11/4 | 3/5  |        -67,042 |         -101,443 |         -101,394 |
| 11/4 | 5/20 |        -14,559 |          -21,925 |          -21,916 |

새 호가 가정에서는 손익이 더 낮았지만 종목/기간·venue·비용/세금·체결 가정의 한계가 남는다. 종료 보유분·미실현 손익·말기 미체결을 보존하며 여러 기간의 수익률을 합산하지 않는다. 이 결과로 전략·한도·운영 모드를 변경하지 않았다.

최종 코드의 private 자료는 `.local-data/execution-rule-studies/c0c94f35-8cff-4b39-852e-0d1999d610be/`에 새 파일로 보관했다. 큰 금액의 반올림 경계 보완 후 24조건을 다시 두 번 실행해 같은 결과 hash를 확인했다. 최초 게시 증거는 이전 `21cb16f6-13df-43c8-90f9-994e42053041` 디렉터리에 그대로 두고 최종 코드에서 기존 게시 6개의 hash·목록·상세를 다시 검증한 publication-reverified를 추가했다. protocol·manifest·result/repeat·review·verification·publication을 저장했고 기존 데이터/결과를 덮어쓰지 않았다. 실험 전체는 private 자료로 보존하고, 결과를 보기 전에 정한 **모든 kospi-ceil 6개**만 기존 대시보드 리포트 루트에 게시했다. 성과가 좋은 것만 고른 것이 아니다. 목록은 총 48개·제외 0·상한 미도달, 6개 상세의 schema/hash 검증을 확인했다. 게시 후보 수를 사전에 검사해 기존 스캔 상한을 우회하지 않았다.

화면의 선택 목록과 조건 비교에서 규칙 실험/기존 모델 및 수수료 산술·거래 장소 가정을 구분한다. profile이 다르면 단순 bps 비용 비교는 비교 불가로 표시한다. 차트/지표 개별 비교를 실제 비용 인과 효과나 실거래 승인으로 확대하지 않는다.

## 최종 검증

최종 코드에서 새 전용 localhost 테스트 DB를 사용한 `verify:ci`가 통과했다. 112파일·871개 테스트(44.41초)와 포맷·린트·타입·전체 빌드를 확인했고 개발/로컬 운영 Compose 설정 검사도 통과했다. 100자리 대금과 큰 bps 곱의 올림 경계를 포함한다. 이 결과는 로컬 전체 검증이며 원격 Actions 결과는 아니다. 테스트 DB 외 업무/Paper DB 변경이나 실제 broker 호출은 하지 않았다.
