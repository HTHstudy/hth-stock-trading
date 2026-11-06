import { expect, expectTypeOf, it } from 'vitest';
import { backtestArtifactSchema, executionRulesSchema } from '@hth/contracts';
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

it('groups only identical explicit execution profiles independently of fee BPS', () => {
  const lower = row('one');
  const higher = row('two', '2');
  const rules = executionRulesSchema.parse({
    formatVersion: 'execution-rules-v1',
    priceRule: 'fixed',
    venueAssumption: 'unspecified',
    boardAssumption: 'unspecified',
    assetClassAssumption: 'unspecified',
    buyFee: { rounding: 'ceil', minimum: '0', maximum: null },
    sellFee: { rounding: 'floor', minimum: '0', maximum: null },
  });
  higher.config.execution.executionRules = structuredClone(rules);
  expect(compareBacktestCosts([lower, higher])).toEqual([]);
  lower.config.execution.executionRules = rules;
  expect(compareBacktestCosts([lower, higher])).toHaveLength(1);
  higher.config.execution.executionRules.buyFee.minimum = '1';
  expect(compareBacktestCosts([lower, higher])).toEqual([]);
});

function evidence(): NonNullable<BacktestCostComparisonRow['executionEvidence']> {
  const report = backtestArtifactSchema.shape.report.shape;
  return {
    signals: report.signals.parse([
      {
        barTimestamp: '2026-01-05T14:30:00Z',
        evaluatedAt: '2026-01-05T14:31:00Z',
        action: 'BUY',
        reason: 'fast average crossed above slow average',
        status: 'FILLED',
      },
      {
        barTimestamp: '2026-01-05T14:35:00Z',
        evaluatedAt: '2026-01-05T14:36:00Z',
        action: 'SELL',
        reason: 'fast average crossed below slow average',
        status: 'FILLED',
      },
    ]),
    fills: report.fills.parse([
      {
        signalIndex: 0,
        action: 'BUY',
        timestamp: '2026-01-05T14:31:00Z',
        barTimestamp: '2026-01-05T14:31:00Z',
        referencePrice: '100',
        price: '100',
        quantity: '1',
        notional: '100',
        fee: '0.01',
        tax: '0',
        cashAfter: '899.99',
      },
      {
        signalIndex: 1,
        action: 'SELL',
        timestamp: '2026-01-05T14:36:00Z',
        barTimestamp: '2026-01-05T14:36:00Z',
        referencePrice: '101',
        price: '101',
        quantity: '1',
        notional: '101',
        fee: '0.0101',
        tax: '0.0101',
        cashAfter: '1000.9698',
      },
    ]),
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
    changedCostFields: ['buyFeeBps', 'sellFeeBps', 'sellTaxBps', 'slippageBps'],
    sameFillTimingAndQuantity: null,
    sameSignalDecisions: null,
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
    higher.config.execution.quantity = '1.00';
    for (const unchanged of ['buyFeeBps', 'sellFeeBps', 'sellTaxBps', 'slippageBps'] as const) {
      if (unchanged !== field) higher.config.execution[unchanged] = '1.00';
    }
    expect(compareBacktestCosts([higher, lower])).toMatchObject([
      { lowerCostVariant: 'one', higherCostVariant: 'two', changedCostFields: [field] },
    ]);
    const mixed = row('mixed', '2');
    mixed.config.execution[field] = '0';
    expect(compareBacktestCosts([lower, mixed])).toEqual([]);
  }
});

it.each(['signalIndex', 'action', 'timestamp', 'barTimestamp', 'quantity'] as const)(
  'detects changed fill %s even when fill counts and signal decisions match',
  (field) => {
    const lower = row('stress');
    const higher = row('base', '2');
    lower.executionEvidence = evidence();
    higher.executionEvidence = evidence();
    const fill = higher.executionEvidence.fills[0]!;
    switch (field) {
      case 'signalIndex':
        fill.signalIndex = 1;
        break;
      case 'action':
        fill.action = 'SELL';
        break;
      case 'timestamp':
        fill.timestamp = '2026-01-05T14:31:01Z';
        break;
      case 'barTimestamp':
        fill.barTimestamp = '2026-01-05T14:32:00Z';
        break;
      case 'quantity':
        fill.quantity = '2';
        break;
    }
    expect(compareBacktestCosts([higher, lower])[0]).toMatchObject({
      sameFillCount: true,
      sameFillTimingAndQuantity: false,
      sameSignalDecisions: true,
    });
  },
);

it('compares execution timing independently of modeled prices, fees, tax and cash', () => {
  const lower = row('one');
  const higher = row('two', '2');
  lower.executionEvidence = evidence();
  higher.executionEvidence = evidence();
  Object.assign(higher.executionEvidence.fills[0]!, {
    referencePrice: '101',
    price: '102',
    notional: '102',
    fee: '0.0204',
    tax: '0.01',
    cashAfter: '897.9696',
  });
  expect(compareBacktestCosts([lower, higher])[0]).toMatchObject({
    sameFillTimingAndQuantity: true,
    sameSignalDecisions: true,
  });
});

it.each(['barTimestamp', 'evaluatedAt', 'action', 'reason', 'status', 'length', 'order'] as const)(
  'compares full signal decisions including %s independently of fills',
  (field) => {
    const lower = row('one');
    const higher = row('two', '2');
    lower.executionEvidence = evidence();
    higher.executionEvidence = evidence();
    const signals = higher.executionEvidence.signals;
    const signal = signals[0]!;
    switch (field) {
      case 'barTimestamp':
        signal.barTimestamp = '2026-01-05T14:29:00Z';
        break;
      case 'evaluatedAt':
        signal.evaluatedAt = '2026-01-05T14:31:01Z';
        break;
      case 'action':
        signal.action = 'HOLD';
        break;
      case 'reason':
        signal.reason = 'no crossing';
        break;
      case 'status':
        signal.status = 'INSUFFICIENT_CASH';
        break;
      case 'length':
        signals.push({ ...signal });
        break;
      case 'order':
        signals.reverse();
        break;
    }
    backtestArtifactSchema.shape.report.shape.signals.parse(signals);
    expect(compareBacktestCosts([lower, higher])[0]).toMatchObject({
      sameFillTimingAndQuantity: true,
      sameSignalDecisions: false,
    });
  },
);

it.each(['lower', 'higher'] as const)('leaves comparisons unknown when %s evidence is missing', (missing) => {
  const lower = row('one');
  const higher = row('two', '2');
  if (missing === 'lower') higher.executionEvidence = evidence();
  else lower.executionEvidence = evidence();
  expect(compareBacktestCosts([lower, higher])[0]).toMatchObject({
    sameFillTimingAndQuantity: null,
    sameSignalDecisions: null,
  });
});

it.each(['lower', 'higher'] as const)('leaves fill timing unknown when %s evidence disagrees with metrics', (side) => {
  const lower = row('one');
  const higher = row('two', '2');
  lower.executionEvidence = evidence();
  higher.executionEvidence = evidence();
  (side === 'lower' ? lower : higher).metrics.fillCount = 3;
  expect(compareBacktestCosts([lower, higher])[0]).toMatchObject({
    sameFillTimingAndQuantity: null,
    sameSignalDecisions: true,
  });
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
    value.executionEvidence = { fills: [], signals: [] };
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
    sameFillTimingAndQuantity: null,
    sameSignalDecisions: true,
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
