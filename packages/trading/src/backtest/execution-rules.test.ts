import { expect, it } from 'vitest';
import type { ExecutionRules } from '@hth/contracts';
import { testDataset } from '../../test/dataset.js';
import type { Strategy } from '../strategy/types.js';
import { runBacktest } from './engine.js';
import { calculateRuleFee, calculateRulePrice, validateExecutionRuleScope } from './execution-rules.js';

function rules(dynamic = false): ExecutionRules {
  return {
    formatVersion: 'execution-rules-v1',
    priceRule: dynamic ? 'krx-kospi-equity-2023' : 'fixed',
    venueAssumption: dynamic ? 'KRX' : 'unspecified',
    boardAssumption: dynamic ? 'KOSPI' : 'unspecified',
    assetClassAssumption: dynamic ? 'common-stock' : 'unspecified',
    buyFee: { rounding: 'ceil', minimum: '0', maximum: null },
    sellFee: { rounding: 'ceil', minimum: '0', maximum: null },
  };
}
const priceInput = {
  referencePrice: '2000',
  slippageBps: '0',
  priceTick: '1',
  side: 'BUY' as const,
  market: 'KR' as const,
  currency: 'KRW' as const,
  tradingDate: '2026-11-02',
};
it.each([
  ['1999', '1', 'BUY', '2000'],
  ['2000', '1', 'BUY', '2005'],
  ['2000', '1', 'SELL', '1999'],
  ['4999', '1', 'BUY', '5000'],
  ['5000', '1', 'SELL', '4995'],
  ['20000', '1', 'BUY', '20050'],
  ['50000', '1', 'BUY', '50100'],
  ['200000', '1', 'BUY', '200500'],
  ['500000', '1', 'BUY', '501000'],
] as const)('가격대 경계 %s/%s/%s → %s', (referencePrice, slippageBps, side, expected) => {
  expect(calculateRulePrice({ ...priceInput, referencePrice, slippageBps, side, rules: rules(true) })).toBe(expected);
});
it.each(['2000', '5000', '20000', '50000', '200000', '500000'])(
  '정확한 가격 경계 %s를 양방향 그대로 유지한다',
  (referencePrice) => {
    for (const side of ['BUY', 'SELL'] as const)
      expect(calculateRulePrice({ ...priceInput, referencePrice, side, rules: rules(true) })).toBe(referencePrice);
  },
);
it('다른 시장·통화·연구 범위 밖 날짜를 고정 tick으로 대체하지 않는다', () => {
  for (const change of [
    { market: 'US' as const },
    { currency: 'USD' as const },
    { tradingDate: '2023-01-24' },
    { tradingDate: '2026-11-07' },
  ])
    expect(() => calculateRulePrice({ ...priceInput, ...change, rules: rules(true) })).toThrow(
      'UNSUPPORTED_EXECUTION_RULE_SCOPE',
    );
  expect(() =>
    validateExecutionRuleScope({
      rules: rules(true),
      market: 'KR',
      currency: 'KRW',
      from: '2023-01-24',
      to: '2026-11-02',
    }),
  ).toThrow('UNSUPPORTED_EXECUTION_RULE_SCOPE');
});
it('통화 단위의 올림/내림과 최소/최대 비용을 십진수로 계산한다', () => {
  const input = { notional: '1.01', feeBps: '10', currency: 'USD' as const, rule: rules().buyFee };
  expect(calculateRuleFee(input)).toBe('0.01');
  expect(calculateRuleFee({ ...input, rule: { ...input.rule, rounding: 'floor' } })).toBe('0');
  expect(calculateRuleFee({ ...input, feeBps: '0', rule: { ...input.rule, minimum: '0.03' } })).toBe('0.03');
  expect(calculateRuleFee({ ...input, notional: '10000', rule: { ...input.rule, maximum: '2' } })).toBe('2');
  expect(calculateRuleFee({ ...input, notional: '0', rule: { ...input.rule, minimum: '2' } })).toBe('0');
  expect(() => calculateRuleFee({ ...input, rule: { ...input.rule, minimum: '0.001' } })).toThrow(
    'INVALID_EXECUTION_RULE',
  );
  expect(() => calculateRuleFee({ ...input, rule: { ...input.rule, minimum: '2', maximum: '1' } })).toThrow(
    'INVALID_EXECUTION_RULE',
  );
  expect(calculateRuleFee({ ...input, notional: '1000000000000000000000000000000000000000', feeBps: '1' })).toBe(
    '100000000000000000000000000000000000',
  );
});

const script: Strategy<Record<number, 'BUY' | 'SELL'>> = {
  id: 'script',
  version: 'fixture',
  evaluate: (context, actions) => ({ action: actions[context.closedCandles.length] ?? 'HOLD', reason: 'FIXTURE' }),
};
const config = {
  initialCash: '1000',
  quantity: '1',
  priceTick: '1',
  buyFeeBps: '0',
  sellFeeBps: '0',
  sellTaxBps: '0',
  slippageBps: '0',
};
const input = {
  dataset: testDataset([
    { open: 100, close: 100 },
    { open: 110, close: 110 },
    { open: 120, close: 120 },
    { open: 110, close: 110 },
  ]),
  strategy: script,
  strategyConfig: { 1: 'BUY', 3: 'SELL' } as const,
  config,
};
it('기본 모델은 그대로 두고 opt-in 모델만 최소 비용과 새 버전을 기록한다', () => {
  const legacy = runBacktest(input),
    profile = rules();
  profile.buyFee.minimum = '2';
  profile.sellFee.minimum = '1';
  const changed = runBacktest({ ...input, config: { ...config, executionRules: profile } });
  expect(legacy).toMatchObject({
    engineVersion: '1.0.0',
    model: 'next-eligible-open-v1',
    metrics: { netPnl: '0', totalFees: '0' },
  });
  expect(legacy.config).not.toHaveProperty('executionRules');
  expect(changed).toMatchObject({
    engineVersion: '1.1.0',
    model: 'next-eligible-open-rules-v1',
    metrics: { netPnl: '-3', totalFees: '3' },
  });
  expect(changed.fills.map((f) => f.fee)).toEqual(['2', '1']);
  expect(changed.fills.map((f) => f.timestamp)).toEqual(legacy.fills.map((f) => f.timestamp));
  expect(runBacktest(input)).toEqual(legacy);
});
it('가격대별 tick은 슬리피지 후의 가격에 적용하고 미래 봉이나 종가 체결을 만들지 않는다', () => {
  const dataset = testDataset([
    { open: 49999, close: 49999 },
    { open: 49999, close: 49999 },
    { open: 49999, close: 49999 },
    { open: 49999, close: 49999 },
  ]);
  const base = { ...config, initialCash: '1000000', slippageBps: '1' };
  const legacy = runBacktest({ ...input, dataset, config: base });
  const report = runBacktest({ ...input, dataset, config: { ...base, executionRules: rules(true) } });
  expect(legacy.fills[0]!.price).toBe('50004');
  expect(report.fills[0]!.price).toBe('50100');
  expect(report.fills[0]!.timestamp).toBe(legacy.fills[0]!.timestamp);
  expect(report.fills[0]!.barTimestamp).toBe(dataset.candles[1]!.timestamp);
  expect(report.warnings).toContain('VENUE_ASSUMPTION_NOT_VERIFIED');
});
it('최소 비용으로 현금이 부족하면 체결을 만들지 않는다', () => {
  const profile = rules();
  profile.buyFee.minimum = '1000';
  const report = runBacktest({ ...input, config: { ...config, executionRules: profile } });
  expect(report.fills).toHaveLength(0);
  expect(report.signals.some((s) => s.status === 'INSUFFICIENT_CASH')).toBe(true);
});

it('100자리 대금과 큰 bps의 곱을 반올림해 ceil 수수료 1원을 잃지 않는다', () => {
  expect(
    calculateRuleFee({
      notional: '9'.repeat(100),
      feeBps: '9999',
      currency: 'KRW',
      rule: rules().buyFee,
    }),
  ).toBe('9999' + '0'.repeat(96));
});
