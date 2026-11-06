import { expect, it } from 'vitest';
import { backtestArtifactSchema, backtestCostPairSchema, executionRulesSchema } from '@hth/contracts';
import type { BacktestArtifact } from '@hth/contracts';
import { contentHash } from '@hth/database';
import { compareBacktestReports } from './backtest-comparison.js';
function artifact() {
  const metrics = {
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
  };
  const payload = {
    formatVersion: 'backtest-artifact-v1',
    dataset: { id: null, contentHash: 'a'.repeat(64), source: 'synthetic-demo' },
    report: {
      formatVersion: 'backtest-report-v1',
      engineVersion: '1.0.0',
      mode: 'paper',
      executionEnabled: false,
      model: 'next-eligible-open-v1',
      strategy: { id: 'moving-average-cross', version: '1.0.0', parameters: { fastPeriod: 2, slowPeriod: 3 } },
      config: {
        initialCash: '1000',
        quantity: '1',
        priceTick: '1',
        buyFeeBps: '0',
        sellFeeBps: '0',
        sellTaxBps: '0',
        slippageBps: '0',
      },
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
      metrics,
    },
  };
  return backtestArtifactSchema.parse({ reportHash: contentHash(payload), ...payload });
}

function higher(left: BacktestArtifact) {
  const value = structuredClone(left);
  value.report.config.buyFeeBps = '1';
  return rehash(value);
}
function rehash(value: BacktestArtifact) {
  const payload = { formatVersion: value.formatVersion, dataset: value.dataset, report: value.report };
  return backtestArtifactSchema.parse({ ...payload, reportHash: contentHash(payload) });
}

it('rejects execution profile changes before checking even identical fee BPS', () => {
  const left = artifact();
  const right = structuredClone(left);
  right.report.model = 'next-eligible-open-rules-v1';
  right.report.engineVersion = '1.1.0';
  right.report.config.executionRules = executionRulesSchema.parse({
    formatVersion: 'execution-rules-v1',
    priceRule: 'fixed',
    venueAssumption: 'unspecified',
    boardAssumption: 'unspecified',
    assetClassAssumption: 'unspecified',
    buyFee: { rounding: 'ceil', minimum: '0', maximum: null },
    sellFee: { rounding: 'floor', minimum: '0', maximum: null },
  });
  expect(compareBacktestReports(left, rehash(right)).reason).toBe('DIFFERENT_EXECUTION');
  const explicitLeft = structuredClone(right);
  right.report.config.executionRules.sellFee.maximum = '10';
  expect(compareBacktestReports(rehash(explicitLeft), rehash(right)).reason).toBe('DIFFERENT_EXECUTION');
  right.report.config.executionRules = structuredClone(explicitLeft.report.config.executionRules);
  right.report.config.buyFeeBps = '1';
  expect(compareBacktestReports(rehash(explicitLeft), rehash(right)).status).toBe('compared');
});

it('blocks model or engine version changes before fee comparison', () => {
  const left = artifact();
  for (const change of ['model', 'engineVersion'] as const) {
    const right = higher(left);
    // Defensive helper boundary; artifact schema rejects these mismatched pairs separately.
    if (change === 'model') right.report.model = 'next-eligible-open-rules-v1';
    else right.report.engineVersion = '1.1.0';
    expect(compareBacktestReports(left, right).reason).toBe('DIFFERENT_EXECUTION');
  }
});

it('orders numeric costs independently of input order and preserves zero-fill comparisons', () => {
  const left = artifact(),
    right = higher(left);
  const before = structuredClone([left, right]);
  const pair = compareBacktestReports(left, right);
  expect(pair).toMatchObject({
    status: 'compared',
    reason: null,
    executionEnabled: false,
    canResume: false,
    comparison: {
      lowerReportHash: left.reportHash,
      higherReportHash: right.reportHash,
      netPnlDelta: '0',
      feesDelta: '0',
      lowerFillCount: 0,
      higherFillCount: 0,
      sameFillCount: true,
      changedCostFields: ['buyFeeBps'],
      sameFillTimingAndQuantity: null,
      sameSignalDecisions: true,
    },
  });
  expect(compareBacktestReports(right, left).comparison).toEqual(pair.comparison);
  expect([left, right]).toEqual(before);
  expect(pair.comparison).not.toHaveProperty('dataset');
  expect(pair.comparison).not.toHaveProperty('role');
  expect(pair.comparison).not.toHaveProperty('lowerCostVariant');
  expect(pair.comparison).not.toHaveProperty('higherCostVariant');
  expect(backtestCostPairSchema.safeParse({ ...pair, path: '/private' }).success).toBe(false);
  expect(
    backtestCostPairSchema.safeParse({ ...pair, comparison: { ...pair.comparison, role: 'research' } }).success,
  ).toBe(false);
  expect(backtestCostPairSchema.safeParse({ ...pair, reason: 'SAME_REPORT' }).success).toBe(false);
});
it('distinguishes same report, equal costs and mixed cost directions', () => {
  const left = artifact();
  expect(compareBacktestReports(left, left).reason).toBe('SAME_REPORT');
  const equal = structuredClone(left);
  equal.report.config.buyFeeBps = '0.00';
  expect(compareBacktestReports(left, rehash(equal)).reason).toBe('COSTS_NOT_ORDERED');
  left.report.config.sellFeeBps = '2';
  expect(compareBacktestReports(rehash(left), higher(artifact())).reason).toBe('COSTS_NOT_ORDERED');
});
it.each([
  [
    'DIFFERENT_DATASET',
    (v: BacktestArtifact) => {
      v.dataset.contentHash = 'b'.repeat(64);
    },
  ],
  [
    'DIFFERENT_DATASET',
    (v: BacktestArtifact) => {
      v.report.currency = 'USD';
    },
  ],
  [
    'DIFFERENT_DATASET',
    (v: BacktestArtifact) => {
      v.report.datasetRequest.to = '2026-03-10';
    },
  ],
  [
    'DIFFERENT_STRATEGY',
    (v: BacktestArtifact) => {
      v.report.strategy.parameters.fastPeriod = 1;
    },
  ],
  [
    'DIFFERENT_EXECUTION',
    (v: BacktestArtifact) => {
      v.report.config.initialCash = '2000';
    },
  ],
  [
    'DIFFERENT_EXECUTION',
    (v: BacktestArtifact) => {
      v.report.config.quantity = '2';
    },
  ],
  [
    'DIFFERENT_EXECUTION',
    (v: BacktestArtifact) => {
      v.report.config.priceTick = '0.1';
    },
  ],
] as const)('rejects incompatible inputs: %s', (reason, change) => {
  const left = artifact(),
    right = higher(left);
  change(right);
  expect(compareBacktestReports(left, rehash(right))).toMatchObject({
    status: 'incomparable',
    reason,
    comparison: null,
  });
});
it('uses content identity rather than storage ID and numeric execution equivalence', () => {
  const left = artifact(),
    right = higher(left);
  right.dataset.id = '00000000-0000-4000-8000-000000000001';
  right.dataset.source = 'file';
  right.report.config.initialCash = '1000.00';
  right.report.config.priceTick = '1.0';
  expect(compareBacktestReports(left, rehash(right)).status).toBe('compared');
});
