# 과거 데이터 수집과 동결 데이터셋

## 현재 범위

`data:backfill`은 한 종목의 날짜별 캘린더와 과거 캔들을 읽는다. 기본값은 dry run이며 DB에 시세를 저장하지 않는다. 토큰 발급과 DB advisory lock은 사용한다. 계좌·보유분 조회와 주문 기능을 호출하지 않는다. `TRADING_MODE=paper`만 허용한다.

```bash
corepack pnpm data:backfill --market=KR --symbol=005930 --from=2026-10-26 --to=2026-10-27 --interval=1d
corepack pnpm data:backfill --market=US --symbol=AAPL --from=2026-10-26 --to=2026-10-27 --interval=1d --adjusted
```

저장이 필요하면 마이그레이션 `0001`의 테이블과 불변성 trigger를 먼저 검토·적용하고 같은 명령에 `--save`를 추가한다. 서버 시작이나 수집 명령에서 마이그레이션을 자동 실행하지 않는다. `broker:sync`도 이제 revision을 함께 기록하므로 `0001`이 필요하다. 사용자 DB에는 이번 작업에서 마이그레이션을 적용하지 않았다.

## 범위와 완전성

- `from`·`to`는 해당 시장의 거래일이며 양끝을 포함한다. 최대 366일, 미래 거래일은 거부한다.
- interval은 `1d` 기본, `1m` 선택이다. adjusted는 기본 false이며 선택을 데이터셋에 보존한다.
- 페이지당 최대 200개, 기본 50페이지, `--max-pages`로 최대 100페이지다. 한 요청의 원본 관측은 최대 20,000개다. 페이지 상한에 도달하면 잘린 결과를 저장하지 않고 실패한다.
- inclusive cursor의 중복 timestamp는 후속 페이지의 관측을 선택하고 양쪽 원본을 보존한다. 진행하지 않는 cursor, 종목·날짜·통화 불일치, 같은 페이지의 충돌은 거부한다.
- 모든 날짜의 실제 캘린더를 별도로 조회한다. 휴장일은 건너뛰되, 캘린더 누락·미확인·잘못된 세션·미완성 봉은 완료로 취급하지 않는다.
- 정규장 분봉은 세션 길이에서 예상 개수를 구한다. 빈 봉을 임의 생성하지 않는다. 일봉은 거래일마다 한 개를 요구한다. 휴장일만 있는 요청은 저장 가능한 데이터셋이 아니다.
- 미국은 거래가 없는 분의 봉을 제공하지 않으므로 정상 데이터도 엄격한 분봉 커버리지 검사를 통과하지 못할 수 있다. MVP에서는 누락 원인을 추측하거나 메우지 않고 동결을 차단한다. 우선 일봉을 사용하고 향후 명시적인 sparse-data 정책을 버전으로 추가한다.
- 과거 NXT 지원 이력을 알 수 없어 현재 지원 여부를 과거에 소급하지 않는다. 국내 마지막 정규 분봉은 보수적으로 비지원 종목의 대기 시간을 적용한다. 일봉은 제공된 전체 세션 종료 후 대기한다. [봉 종료 정책](MARKET_DATA_POLICY.md)을 재사용한다.

dry run은 완료 여부·봉 개수·누락 수 등 요약만 출력한다. `--save`는 모든 검사를 통과한 데이터만 한 트랜잭션으로 동결한다. 실패 시 부분 저장하지 않는다. 범위가 크면 날짜를 나눠 명시적으로 실행한다. 주기 수집·자동 재개 checkpoint는 아직 없다.

## 최신값·revision·데이터셋의 관계

`candles`는 기존 수집 명령의 최신값 캐시다. `candle_revisions`는 종목·interval·timestamp·adjusted·source별 서로 다른 OHLCV 값을 추가만 한다. 십진 문자열의 불필요한 0과 timestamp 표현을 정규화한 SHA-256으로 동일한 값을 중복 저장하지 않는다. isClosed만 변경돼도 가격 revision을 새로 만들지는 않는다. revision 저장 시각과 실제 원본 관측 시각은 다르며 후자는 데이터셋에 보존한다.

`historical_datasets`는 요청 조건, 수집 시작/종료, 종목 메타데이터, 날짜별 캘린더, 페이지별 원본 관측, 종료 판정, 정규장 선택 봉과 커버리지를 JSONB로 함께 보관한다. 최신 `candles`를 다시 조회해 입력을 재구성하지 않는다. JSON 객체 키를 정렬한 UTF-8 직렬화의 SHA-256을 저장하며 읽을 때 스키마와 hash를 다시 검증한다. 같은 artifact의 재저장은 같은 ID를 반환한다. 관측 시각을 포함하므로 별도 수집은 가격이 같아도 다른 데이터셋일 수 있다.

두 이력 테이블은 UPDATE·DELETE·TRUNCATE를 DB trigger로 거부한다. insert의 `ON CONFLICT DO NOTHING`은 허용한다. DB 관리자가 trigger를 제거하는 것까지 막는 보안 경계나 외부 공증은 아니다. 백업·역할 분리·보관 기간 정책은 운영 단계에 추가한다.

```bash
corepack pnpm data:export
corepack pnpm data:export --id=<데이터셋 UUID> --output=../../.local-data/dataset.json
```

첫 명령은 최근 100개 ID·hash·생성 시각만 보여준다. 출력 경로는 worker 디렉터리 기준이다. `.local-data/`는 gitignore에 포함하며 export는 새 JSON 파일만 생성한다. 기존 파일은 덮어쓰지 않고 신규 디렉터리 권한 0700, 파일 권한 0600을 사용한다. 내보낸 형식은 `{ id, contentHash, dataset }`이고 hash는 dataset 자체의 `contentHash(dataset)`으로 재검증할 수 있다. 계좌나 인증 정보는 포함하지 않는다. 외부 배포나 시세 재배포 용도가 아니다.

## 재현성과 과거 시점 정확도의 차이

이 기능은 **수집한 동일 입력의 재현성**을 제공한다. 과거 당시 알려졌던 정보만 담은 point-in-time 데이터는 아니므로 `pointInTime=false`를 고정한다. 현재 종목 메타데이터, 사후 기업행위 조정, 늦은 체결, 상장폐지 종목 누락에 따른 편향은 남는다. 당시 원 가격·거래 가능 가격·전체 미국 거래소 시세를 보장하지 않는다. `adjusted=false`도 오래된 구간의 원 가격을 보장하지 않는다. 공식 [FAQ](https://openapi.tossinvest.com/openapi-docs/faq.md)를 2026-10-28 재확인했다.

전략·백테스트 결과는 데이터셋 ID/hash, 전략 버전·파라미터, 체결 모델과 비용 설정을 함께 기록한다. 이동평균 전략과 봉 가용 시각 이후 시가 체결, 성과 리포트 CLI를 구현했다. [백테스트 실행·한계](BACKTESTING.md)를 따른다. 이 데이터셋은 실시간 전략 입력의 신선도 검사나 주문 실행 승인을 대신하지 않는다.

## 검증

순수 함수·가짜 broker 테스트로 커버리지, 페이지 경계, 취소·미래 범위, 가격 정규화를 확인한다. 전용 임시 PostgreSQL에서는 새 마이그레이션, revision 보존, 동결 멱등성, 과거 snapshot 유지, 변경·삭제·truncate 차단을 검증한다. 통합 테스트는 localhost의 `hth_test` 사용자와 `hth_readonly_test` DB만 허용한다.

2026-10-28 실제 읽기 전용 연결로 국내 2026-10-26~27 일봉 dry run을 검증했다. 선택 봉 2개·관측 2개·누락 0개·complete=true·saved=false였으며 계좌 조회·주문·시세 저장은 실행하지 않았다. 테스트 코드에서는 실제 증권사 API를 호출하지 않았다.
