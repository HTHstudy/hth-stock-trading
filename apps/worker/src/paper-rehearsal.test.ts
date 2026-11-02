import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assessMarketData, paperSessionState, movingAverageCross } from '@hth/trading';
import { parsePaperRehearsalConfig, paperRehearsalPlanSchema } from './paper-rehearsal-plan.js';
import { rehearsalEvidence } from './paper-rehearsal-source.js';

const plan = JSON.parse(readFileSync(new URL('../../../examples/paper-rehearsal-plan.json', import.meta.url), 'utf8'));
const url = 'postgresql://hth_test:test@127.0.0.1:5432/hth_readonly_test';
describe('Paper 리허설 경계', () => {
  it('기본은 DB와 인증키 없이 미리보기만 한다', () => {
    expect(
      parsePaperRehearsalConfig([], { DATABASE_URL: 'do-not-use', TOSS_CLIENT_SECRET: 'do-not-use' }),
    ).toMatchObject({
      execute: false,
      prepare: false,
      databaseUrl: null,
    });
    expect(parsePaperRehearsalConfig(['--execute'], { PAPER_REHEARSAL_DATABASE_URL: url }).databaseUrl).toBe(url);
    expect(paperRehearsalPlanSchema.parse(plan).profiles).toHaveLength(2);
  });
  it.each([
    [['--prepare'], {}],
    [['--execute'], { DATABASE_URL: url }],
    [['--resume'], {}],
    [['--account', 'existing'], {}],
    [[], { TRADING_MODE: 'live' }],
    [['--execute'], { PAPER_REHEARSAL_DATABASE_URL: url.replace('127.0.0.1', 'remote.example') }],
    [['--execute'], { PAPER_REHEARSAL_DATABASE_URL: url.replace('hth_readonly_test', 'user_db') }],
    [['--execute'], { PAPER_REHEARSAL_DATABASE_URL: `${url}?options=-csearch_path=public` }],
    [['--execute'], { PAPER_REHEARSAL_DATABASE_URL: url.replace('postgresql:', 'https:') }],
  ] as const)('안전 경계를 벗어난 설정을 거부한다 %j', (args, env) => {
    expect(() => parsePaperRehearsalConfig([...args], env)).toThrow('PAPER_REHEARSAL_CONFIGURATION_INVALID');
  });
  it.each([
    (p: typeof plan) => {
      p.executionEnabled = true;
    },
    (p: typeof plan) => {
      p.source = 'market-observation';
    },
    (p: typeof plan) => {
      p.accountId = 'existing';
    },
    (p: typeof plan) => {
      p.profiles[0].flat[0] = '0';
    },
    (p: typeof plan) => {
      p.profiles.push(p.profiles[0]);
    },
    (p: typeof plan) => {
      p.profiles[0].manualInstrument = p.profiles[0].instrument;
    },
  ])('실행 권한/출처/잘못된 합성 조건을 거부한다', (mutate) => {
    const input = structuredClone(plan);
    mutate(input);
    expect(paperRehearsalPlanSchema.safeParse(input).success).toBe(false);
  });
});

describe('KR/US 합성 시세는 실제 신선도 게이트를 통과한다', () => {
  it('분이 바뀌어도 같은 리허설 계좌의 봉 시각은 고정하고 시세 관측 시각만 갱신한다', () => {
    for (const [instrument, anchor, later] of [
      [{ market: 'US', symbol: 'AAPL' }, '2026-11-02T01:02:59.900Z', '2026-11-02T01:03:00.100Z'],
      [{ market: 'KR', symbol: '005930' }, '2026-11-01T15:01:59.900Z', '2026-11-01T15:03:00.100Z'],
    ] as const) {
      const first = rehearsalEvidence(instrument, ['1000', '900', '1100'], anchor, anchor);
      const second = rehearsalEvidence(instrument, ['1000', '900', '1100'], later, anchor);
      expect(second.marketData.candles).toEqual(first.marketData.candles);
      expect(second.quote.observedAt).not.toBe(first.quote.observedAt);
      expect(second.marketData.candles.every((c) => !c.isClosed)).toBe(true);
    }
  });
  it('거래일 전환 전후와 CI 실패 시각에도 종료 봉 3개와 매수 교차를 유지한다', () => {
    const cases: { market: 'KR' | 'US'; asOf: string }[] = [{ market: 'US', asOf: '2026-11-02T01:02:35Z' }];
    for (const [market, boundary] of [
      ['KR', '2026-11-01T15:00:00Z'],
      ['US', '2026-10-31T00:00:00Z'],
      ['US', '2026-11-02T01:00:00Z'],
    ] as const)
      for (const minute of [-2, -1, 0, 1, 2, 3, 4, 5])
        cases.push({ market, asOf: new Date(Date.parse(boundary) + minute * 60000 + 30000).toISOString() });
    for (const { market, asOf } of cases) {
      const instrument = { market, symbol: market === 'KR' ? '005930' : 'AAPL' };
      const entry = rehearsalEvidence(instrument, ['1000', '900', '1100'], asOf);
      const result = assessMarketData({
        ...entry.marketData,
        instrument,
        quoteTimestamp: entry.quote.timestamp,
        quoteObservedAt: asOf,
        asOf,
      });
      expect(result.blockers, `${market} ${asOf}`).toEqual([]);
      expect(result.candles, `${market} ${asOf}`).toHaveLength(3);
      expect(
        movingAverageCross.evaluate(
          { instrument, evaluatedAt: asOf, closedCandles: result.candles, ownedQuantity: '0' },
          { fastPeriod: 1, slowPeriod: 2 },
        ).action,
      ).toBe('BUY');
    }
  });
  it.each([
    '2026-10-30T01:45:30Z',
    '2026-01-15T14:30:30Z',
    '2026-03-08T07:30:30Z',
    '2026-11-01T06:30:30Z',
    '2026-10-30T15:00:30Z',
    '2026-10-31T00:00:30Z',
  ])('일자/DST 경계 %s', (asOf) => {
    for (const market of ['KR', 'US'] as const) {
      const instrument = { market, symbol: market === 'KR' ? '005930' : 'AAPL' };
      const entry = rehearsalEvidence(instrument, ['1000', '900', '1100'], asOf);
      expect(paperSessionState([entry], [instrument], asOf)).toBe('open');
      const result = assessMarketData({
        ...entry.marketData,
        instrument,
        quoteTimestamp: entry.quote.timestamp,
        quoteObservedAt: asOf,
        asOf,
      });
      expect(result.blockers).toEqual([]);
      expect(result.ready).toBe(true);
      expect(result.candles).toHaveLength(3);
      expect(result.candles.every((candle) => candle.isClosed)).toBe(true);
      expect(entry.marketData.candles.every((candle) => !candle.isClosed)).toBe(true);
    }
  });
});
