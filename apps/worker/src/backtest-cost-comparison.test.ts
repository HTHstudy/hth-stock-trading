import { expect, expectTypeOf, it } from 'vitest';
import { compareBacktestCosts } from './backtest-cost-comparison.js';
import type { BacktestCostComparisonRow } from './backtest-cost-comparison.js';
import type { reviewBacktestExperiment } from './backtest-experiment-review.js';

function row(variant: string, cost = '1'): BacktestCostComparisonRow {
  return {
    dataset: 'dataset-one',
    role: 'research',
    variant,
    reportHash: variant.padEnd(64, '0'),
    config: {
      strategy: { fastPeriod: 3, slowPeriod: 5 },
      execution: {
        initialCash: '1000',
        quantity: '1',
        priceTick: '0.01',
        buyFeeBps: cost,
        sellFeeBps: cost,
        sellTaxBps: cost,
        slippageBps: cost,
      },
    },
    metrics: {
      initialCash: '1000',
      endingCash: '1000.3',
      endingQuantity: '0',
      endingEquity: '1000.3',
      netPnl: '0.3',
      realizedPnl: '0.3',
      unrealizedPnl: '0',
      cumulativeReturnPct: '0.03',
      maxDrawdownPct: '0',
      winRatePct: '100',
      tradeCount: 1,
      fillCount: 2,
      totalFees: '0.1',
      totalTax: '0.01',
    },
  };
}

it('accepts review rows structurally and compares every unordered pair without interpreting variant IDs', () => {
  expectTypeOf<ReturnType<typeof reviewBacktestExperiment>['rows']>().toExtend<BacktestCostComparisonRow[]>();
  const lower = row('stress', '1');
  const higher = row('base', '3');
  higher.metrics.netPnl = '0.1';
  higher.metrics.totalFees = '0.3';
  higher.metrics.totalTax = '100';
  const middle = row('arbitrary', '2');
  const rows = [higher, lower, middle];
  const before = structuredClone(rows);
  const pairs = compareBacktestCosts(rows);
  expect(pairs).toHaveLength(3);
  expect(pairs[0]).toEqual({
    dataset: 'dataset-one',
    role: 'research',
    lowerCostVariant: 'stress',
    higherCostVariant: 'base',
    lowerReportHash: lower.reportHash,
    higherReportHash: higher.reportHash,
    netPnlDelta: '-0.2',
    feesDelta: '0.2',
    lowerFillCount: 2,
    higherFillCount: 2,
    sameFillCount: true,
    interpretation: 'MODELED_COST_SCENARIO_COMPARISON',
  });
  expect(pairs.map((pair) => [pair.lowerCostVariant, pair.higherCostVariant])).toEqual([
    ['stress', 'base'],
    ['arbitrary', 'base'],
    ['stress', 'arbitrary'],
  ]);
  expect(compareBacktestCosts(rows)).toEqual(pairs);
  expect(rows).toEqual(before);
});

it('never pairs different datasets, roles, strategy parameters, funding, quantity or ticks', () => {
  const lower = row('one');
  const changes: ((value: BacktestCostComparisonRow) => void)[] = [
    (value) => {
      value.dataset = 'other';
    },
    (value) => {
      value.role = 'validation';
    },
    (value) => {
      value.config.strategy.fastPeriod = 2;
    },
    (value) => {
      value.config.strategy.slowPeriod = 6;
    },
    (value) => {
      value.config.execution.initialCash = '2000';
    },
    (value) => {
      value.config.execution.quantity = '2';
    },
    (value) => {
      value.config.execution.priceTick = '1';
    },
  ];
  for (const change of changes) {
    const higher = row('two', '2');
    change(higher);
    expect(compareBacktestCosts([lower, higher])).toEqual([]);
  }
});

it('requires strict dominance across all four costs, allowing equality but excluding mixed directions', () => {
  const lower = row('one');
  expect(compareBacktestCosts([])).toEqual([]);
  expect(compareBacktestCosts([lower])).toEqual([]);
  expect(compareBacktestCosts([lower, row('equal', '1.00')])).toEqual([]);
  for (const field of ['buyFeeBps', 'sellFeeBps', 'sellTaxBps', 'slippageBps'] as const) {
    const higher = row('two');
    higher.config.execution[field] = '1.00000000000000000001';
    higher.config.execution.initialCash = '1000.00';
    higher.config.execution.priceTick = '0.010';
    expect(compareBacktestCosts([higher, lower])).toHaveLength(1);
    const mixed = row('mixed', '2');
    mixed.config.execution[field] = '0';
    expect(compareBacktestCosts([lower, mixed])).toEqual([]);
  }
});

it('preserves long exact decimal deltas without floating point or default Decimal rounding', () => {
  const lower = row('one');
  const higher = row('two', '2');
  const whole = '9'.repeat(250);
  const fraction = `${'0'.repeat(248)}1`;
  higher.metrics.netPnl = whole;
  lower.metrics.netPnl = `0.${fraction}`;
  higher.metrics.totalFees = '9007199254740993.3';
  lower.metrics.totalFees = '9007199254740993.1';
  expect(compareBacktestCosts([lower, higher])[0]).toMatchObject({
    netPnlDelta: `${'9'.repeat(249)}8.${'9'.repeat(249)}`,
    feesDelta: '0.2',
  });
});

it('retains explicit zero-fill scenarios and exposes differing fill counts without causal claims', () => {
  const lower = row('one');
  const higher = row('two', '2');
  for (const value of [lower, higher]) {
    value.metrics.fillCount = 0;
    value.metrics.tradeCount = 0;
    value.metrics.netPnl = '0';
    value.metrics.totalFees = '0';
    value.metrics.winRatePct = null;
  }
  expect(compareBacktestCosts([lower, higher])[0]).toMatchObject({
    netPnlDelta: '0',
    feesDelta: '0',
    lowerFillCount: 0,
    higherFillCount: 0,
    sameFillCount: true,
  });
  lower.metrics.fillCount = 4;
  lower.metrics.tradeCount = 2;
  higher.metrics.fillCount = 1;
  higher.metrics.netPnl = '1';
  higher.metrics.totalFees = '0.1';
  expect(compareBacktestCosts([lower, higher])[0]).toMatchObject({
    netPnlDelta: '1',
    feesDelta: '0.1',
    lowerFillCount: 4,
    higherFillCount: 1,
    sameFillCount: false,
    interpretation: 'MODELED_COST_SCENARIO_COMPARISON',
  });
});
