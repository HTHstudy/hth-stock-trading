import { expect, it } from 'vitest';
import { parsePaperMarketConfig } from './paper-market-config.js';

const environment = {
  TOSS_CLIENT_ID: 'fixture-client',
  TOSS_CLIENT_SECRET: 'fixture-secret',
  DATABASE_URL: 'postgresql://hth:fixture@localhost:5432/hth_trading',
  PAPER_MARKET_DATABASE_URL: 'postgresql://hth_test:fixture@127.0.0.1:55434/hth_readonly_test',
};
const args = ['--account=paper-market-test'];
it('기본 정지·1회 관측이며 KR/US 초기화 종목을 검증한다', () => {
  expect(parsePaperMarketConfig(args, environment)).toMatchObject({
    resume: false,
    initialize: false,
    prepare: false,
    stop: false,
    ticks: 1,
  });
  expect(parsePaperMarketConfig([...args, '--initialize', '--symbol=US:AAPL'], environment).instrument).toEqual({
    market: 'US',
    symbol: 'AAPL',
  });
});
it.each(
  [
    [],
    ['--account=paper-demo-test'],
    [...args, '--unknown'],
    [...args, '--initialize', '--resume'],
    [...args, '--prepare', '--resume'],
    [...args, '--stop', '--resume'],
    [...args, '--stop', '--prepare'],
    [...args, '--stop', '--ticks=1'],
    [...args, '--symbol=US:AAPL'],
    [...args, '--ticks=0'],
    [...args, '--ticks=NaN'],
    [...args, '--initialize', '--symbol=US:bad&secret'],
  ].map((input) => [input] as const),
)('잘못된 인자 조합을 거부한다: %j', (input) => {
  expect(() => parsePaperMarketConfig(input, environment)).toThrow('PAPER_MARKET_CONFIGURATION_INVALID');
});
it.each([
  { TRADING_MODE: 'live' },
  { TOSS_CLIENT_SECRET: '' },
  { PAPER_MARKET_DATABASE_URL: undefined },
  { PAPER_MARKET_DATABASE_URL: 'postgresql://hth_test:fixture@remote.invalid:5432/hth_readonly_test' },
  { PAPER_MARKET_DATABASE_URL: 'postgresql://hth:fixture@127.0.0.1:55434/hth_trading' },
  { PAPER_MARKET_DATABASE_URL: `${environment.PAPER_MARKET_DATABASE_URL}?options=unsafe` },
  { DATABASE_URL: 'postgresql://hth_test:fixture@localhost:55434/hth_readonly_test' },
  { DATABASE_URL: 'https://invalid.example' },
])('잘못된 환경 설정은 값을 노출하지 않고 거부한다: %j', (override) => {
  expect(() => parsePaperMarketConfig(args, { ...environment, ...override })).toThrow(
    /^PAPER_MARKET_CONFIGURATION_INVALID$/,
  );
});
it('긴급 정지는 증권사 키나 토큰 잠금 DB 없이 사용할 수 있다', () => {
  expect(
    parsePaperMarketConfig([...args, '--stop'], { PAPER_MARKET_DATABASE_URL: environment.PAPER_MARKET_DATABASE_URL })
      .stop,
  ).toBe(true);
});
