import { expect, it } from 'vitest';
import { parseMarketObservationConfig } from './market-observation-config.js';

it('합성 데모는 키/DB 없이 가능하며 실제 관측은 설정을 명시해야 한다', () => {
  expect(parseMarketObservationConfig(['--demo'], {})).toMatchObject({
    source: 'synthetic-only',
    samples: 1,
    broker: null,
    intervalMs: 60000,
  });
  expect(() => parseMarketObservationConfig([], {})).toThrow('MARKET_OBSERVATION_CONFIGURATION_INVALID');
});
it.each(
  [
    ['--demo', '--samples=0'],
    ['--demo', '--interval-seconds=1'],
    ['--demo', '--symbols=US:AAPL'],
    ['--resume'],
    ['--demo', '--symbols=KR:005930,KR:005930'],
    ['--demo', '--samples=10001'],
    ['--demo', '--regular-only'],
    ['--demo', '--start-at=2026-10-29T13:35:00Z'],
  ].map((args) => [args] as const),
)('의도하지 않은 실행 옵션을 거부한다: %j', (args) => {
  expect(() => parseMarketObservationConfig(args, {})).toThrow('MARKET_OBSERVATION_CONFIGURATION_INVALID');
});
it('정규장 대기는 실제 시세 단일 시장만 허용한다', () => {
  const env = {
    TOSS_CLIENT_ID: 'fixture',
    TOSS_CLIENT_SECRET: 'fixture',
    DATABASE_URL: 'postgresql://localhost/unused',
  };
  expect(
    parseMarketObservationConfig(['--symbols=US:AAPL', '--regular-only', '--start-at=2026-10-29T13:35:00Z'], env),
  ).toMatchObject({ regularMarket: 'US', startAt: '2026-10-29T13:35:00Z' });
  expect(() => parseMarketObservationConfig(['--regular-only'], env)).toThrow();
  expect(() =>
    parseMarketObservationConfig(['--regular-only', '--symbols=US:AAPL', '--start-at=tomorrow'], env),
  ).toThrow();
});
it('live와 관측 범위를 벗어나는 캔들 설정을 거부한다', () => {
  expect(() => parseMarketObservationConfig(['--demo'], { TRADING_MODE: 'live' })).toThrow();
  const env = {
    TOSS_CLIENT_ID: 'fixture',
    TOSS_CLIENT_SECRET: 'fixture',
    DATABASE_URL: 'postgresql://localhost/unused',
  };
  expect(parseMarketObservationConfig([], env).instruments).toHaveLength(2);
  expect(() => parseMarketObservationConfig([], { ...env, CANDLE_INTERVAL: '1d' })).toThrow();
  expect(() => parseMarketObservationConfig([], { ...env, CANDLE_MAX_PAGES: '5' })).toThrow();
});
