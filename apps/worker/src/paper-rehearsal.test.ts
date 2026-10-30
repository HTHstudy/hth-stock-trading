import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assessMarketData, paperSessionState } from '@hth/trading';
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
