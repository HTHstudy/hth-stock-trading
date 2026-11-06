import { expect, it } from 'vitest';
import { backtestConfigSchema } from './backtest.js';
import { backtestReportSchema } from './backtest-reports.js';
import { executionRulesSchema } from './execution-rules.js';
import type { ExecutionRules } from './execution-rules.js';

function rules(): ExecutionRules {
  return {
    formatVersion: 'execution-rules-v1',
    priceRule: 'fixed',
    venueAssumption: 'unspecified',
    boardAssumption: 'unspecified',
    assetClassAssumption: 'unspecified',
    buyFee: { rounding: 'ceil', minimum: '0', maximum: null },
    sellFee: { rounding: 'floor', minimum: '0', maximum: '1' },
  };
}

const config = {
  initialCash: '1000',
  quantity: '1',
  priceTick: '1',
  buyFeeBps: '0',
  sellFeeBps: '0',
  sellTaxBps: '0',
  slippageBps: '0',
};

it('preserves legacy config serialization without injecting an execution profile', () => {
  const parsed = backtestConfigSchema.parse(config);
  expect(parsed).not.toHaveProperty('executionRules');
  expect(JSON.stringify(parsed)).toBe(JSON.stringify(config));
  expect(backtestConfigSchema.parse({ ...config, executionRules: rules() }).executionRules).toEqual(rules());
});

it('requires matching explicit assumptions for both price rules', () => {
  for (const priceRule of ['fixed', 'krx-kospi-equity-2023'] as const) {
    for (const venueAssumption of ['unspecified', 'KRX'] as const) {
      for (const boardAssumption of ['unspecified', 'KOSPI'] as const) {
        for (const assetClassAssumption of ['unspecified', 'common-stock'] as const) {
          expect(
            executionRulesSchema.safeParse({
              ...rules(),
              priceRule,
              venueAssumption,
              boardAssumption,
              assetClassAssumption,
            }).success,
          ).toBe(
            priceRule === 'fixed'
              ? venueAssumption === 'unspecified' &&
                  boardAssumption === 'unspecified' &&
                  assetClassAssumption === 'unspecified'
              : venueAssumption === 'KRX' && boardAssumption === 'KOSPI' && assetClassAssumption === 'common-stock',
          );
        }
      }
    }
  }
});

it.each(['buyFee', 'sellFee'] as const)('compares %s bounds exactly without floating point', (side) => {
  for (const [minimum, maximum, valid] of [
    ['9007199254740993.2', '9007199254740993.1', false],
    ['0.0000000000000000000000000001', '0.0000000000000000000000000000', false],
    ['0001.20', '1.2', true],
    ['1.01', '1.1', true],
    ['9'.repeat(30), null, true],
    ['9'.repeat(31), null, false],
    ['0', '9'.repeat(31), false],
  ] as const) {
    const value = rules();
    value[side] = { ...value[side], minimum, maximum };
    expect(executionRulesSchema.safeParse(value).success).toBe(valid);
  }
});

it('rejects missing, unknown and malformed fields at both levels', () => {
  const missingBoard = { ...rules() };
  Reflect.deleteProperty(missingBoard, 'boardAssumption');
  expect(executionRulesSchema.safeParse(missingBoard).success).toBe(false);
  expect(executionRulesSchema.safeParse({ ...rules(), priceRule: 'krx-equity-2023' }).success).toBe(false);
  for (const boardAssumption of ['KOSDAQ', 'KONEX']) {
    expect(executionRulesSchema.safeParse({ ...rules(), boardAssumption }).success).toBe(false);
  }
  for (const assetClassAssumption of ['equity', 'preferred-stock', 'ETF', 'ETN', 'REIT']) {
    expect(executionRulesSchema.safeParse({ ...rules(), assetClassAssumption }).success).toBe(false);
  }
  expect(executionRulesSchema.safeParse({ ...rules(), verifiedActual: true }).success).toBe(false);
  expect(executionRulesSchema.safeParse({ ...rules(), formatVersion: 'execution-rules-v2' }).success).toBe(false);
  for (const value of ['-1', '+1', '1e2', 'NaN', '', '.1', '1.', 1, null]) {
    for (const field of ['minimum', 'maximum'] as const) {
      if (field === 'maximum' && value === null) continue;
      expect(
        executionRulesSchema.safeParse({ ...rules(), buyFee: { ...rules().buyFee, [field]: value } }).success,
      ).toBe(false);
    }
  }
  for (const buyFee of [
    { rounding: 'ceil', minimum: '0' },
    { ...rules().buyFee, rounding: 'round' },
    { ...rules().buyFee, extra: true },
  ]) {
    expect(executionRulesSchema.safeParse({ ...rules(), buyFee }).success).toBe(false);
  }
});

it('orders validated fields deterministically without normalizing decimal strings', () => {
  const value = rules();
  value.buyFee.minimum = '00.0';
  const reordered = Object.fromEntries(Object.entries(value).reverse());
  reordered.buyFee = { maximum: null, minimum: '00.0', rounding: 'ceil' };
  expect(JSON.stringify(executionRulesSchema.parse(reordered))).toBe(JSON.stringify(value));
});

it('requires the correct model/version pair for presence or absence of rules', () => {
  const report = {
    formatVersion: 'backtest-report-v1',
    mode: 'paper',
    executionEnabled: false,
    strategy: { id: 'moving-average-cross', version: '1.0.0', parameters: { fastPeriod: 1, slowPeriod: 2 } },
    currency: 'KRW',
    datasetRequest: {
      instrument: { market: 'KR', symbol: 'DEMO' },
      interval: '1d',
      adjusted: false,
      from: '2026-03-09',
      to: '2026-03-09',
      source: 'synthetic-demo-v1',
    },
    pointInTime: false,
    warnings: [],
    signals: [],
    fills: [],
    trades: [],
    equity: [
      {
        timestamp: '2026-03-09T00:00:00Z',
        kind: 'initial',
        equity: '1000',
        cash: '1000',
        quantity: '0',
        cumulativeReturnPct: '0',
      },
    ],
    metrics: {
      initialCash: '1000',
      endingCash: '1000',
      endingQuantity: '0',
      endingEquity: '1000',
      netPnl: '0',
      realizedPnl: '0',
      unrealizedPnl: '0',
      cumulativeReturnPct: '0',
      maxDrawdownPct: '0',
      winRatePct: null,
      tradeCount: 0,
      fillCount: 0,
      totalFees: '0',
      totalTax: '0',
    },
  };
  for (const present of [false, true]) {
    for (const model of ['next-eligible-open-v1', 'next-eligible-open-rules-v1']) {
      for (const engineVersion of ['1.0.0', '1.1.0', '1.2.0']) {
        const result = backtestReportSchema.safeParse({
          ...report,
          model,
          engineVersion,
          config: present ? { ...config, executionRules: rules() } : config,
        });
        expect(result.success).toBe(
          present
            ? model === 'next-eligible-open-rules-v1' && engineVersion === '1.1.0'
            : model === 'next-eligible-open-v1' && engineVersion === '1.0.0',
        );
      }
    }
  }
});
