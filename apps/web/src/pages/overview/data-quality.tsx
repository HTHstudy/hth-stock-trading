import type { DataBlocker, MarketDataQuality } from '@shared/api/dashboard';
import { formatTime } from '@shared/lib/format';

const explanations: Record<DataBlocker, string> = {
  INVALID_DATA: '데이터 형식·순서 불일치',
  CALENDAR_MISSING: '해당 거래일 일정 없음',
  CALENDAR_UNKNOWN: '시장 일정 미확인',
  CALENDAR_STALE: '시장 일정 재조회 필요',
  MARKET_CLOSED: '정규장 거래 시간 아님',
  OUTSIDE_REGULAR_SESSION: '시간외 봉 제외',
  METADATA_MISSING: '종목 정보 미확인',
  BAR_NOT_SETTLED: '봉 종료 대기',
  BAR_NOT_REOBSERVED: '종료 후 재수집 필요',
  QUOTE_TIME_MISSING: '시세 시각 미제공',
  QUOTE_STALE: '시세 시각이 오래됨',
  ACCOUNT_STALE: '계좌 정보 재조회 필요',
  FX_EXPIRED: '환율 유효시간 경과',
  FUTURE_DATA: '미래 시각 감지',
  NO_CLOSED_CANDLES: '종료 확인 봉 없음',
  CANDLES_STALE: '캔들 재조회 필요',
  INSTRUMENT_RESTRICTED: '거래 제한·종목 정보 미확인',
  ACCOUNT_UNAVAILABLE: '조회 가능한 계좌 없음',
};

export function DataQualityPanel({ quality, now }: { quality: MarketDataQuality | undefined; now: number }) {
  const ready =
    quality?.instruments.filter((item) => item.ready && item.validUntil && Date.parse(item.validUntil) > now).length ??
    0;
  return (
    <section aria-label="전략 입력 데이터 검증" className="mt-6 rounded-2xl border border-slate-800 bg-[#111a2b] p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">전략 입력 데이터 검증</h2>
          <p className="mt-1.5 text-xs leading-5 text-slate-500">
            세션·봉 종료·시세·계좌·환율을 검사합니다. 통과 여부는 매매 실행 권한과 무관합니다.
          </p>
        </div>
        <span className="text-xs text-slate-400">
          {quality ? `현재 입력 조건 충족 ${ready}/${quality.instruments.length}` : '아직 검증하지 않음'}
        </span>
      </div>
      {quality && (
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {quality.instruments.map((item) => {
            const expired = item.ready && (!item.validUntil || Date.parse(item.validUntil) <= now);
            return (
              <article key={item.key} className="rounded-lg border border-slate-800 px-4 py-3">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="font-mono text-slate-300">{item.key}</span>
                  <span className={item.ready && !expired ? 'text-teal-300' : 'text-amber-200'}>
                    {expired ? '검증 유효시간 경과' : item.ready ? '입력 조건 충족' : '전략 입력 차단'}
                  </span>
                </div>
                <p className="mt-2 text-[11px] text-slate-500">
                  종료 확인 {item.closedCandles} · 대기 {item.pendingCandles} · 제외 {item.blockedCandles}개 봉
                </p>
                <p className="mt-2 text-xs leading-5 text-slate-400">
                  {expired
                    ? '새로고침 후 다시 검증해주세요.'
                    : item.blockers.length
                      ? item.blockers.map((reason) => explanations[reason]).join(' · ')
                      : '현재 검사 조건을 충족했습니다. 전략·리스크·주문 엔진은 아직 실행하지 않습니다.'}
                </p>
              </article>
            );
          })}
        </div>
      )}
      <p className="mt-3 text-[10px] leading-5 text-slate-600">
        {quality ? `검사 ${formatTime(quality.checkedAt)} · ${quality.policyVersion} · ` : ''}봉 구간 종료 확인은 원천
        데이터의 영구 불변 보장이 아닙니다. 늦은 체결·수정주가에 따라 과거 값이 바뀔 수 있습니다.
      </p>
    </section>
  );
}
