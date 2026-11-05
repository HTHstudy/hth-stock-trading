import { Decimal } from 'decimal.js';
import { backtestCostPairSchema } from '@hth/contracts';
import type { BacktestArtifact, BacktestCostPair } from '@hth/contracts';
import { compareBacktestCosts } from './backtest-cost-comparison.js';
import type { BacktestCostComparisonRow } from './backtest-cost-comparison.js';

// Compare validated artifacts only. This helper performs no I/O or strategy execution.
export function compareBacktestReports(left: BacktestArtifact, right: BacktestArtifact): BacktestCostPair {
  const base = {
    formatVersion: 'backtest-cost-pair-v1',
    leftReportHash: left.reportHash,
    rightReportHash: right.reportHash,
    currency: left.report.currency,
    executionEnabled: false,
    canResume: false,
  } as const;
  const incomparable = (reason: Extract<BacktestCostPair, { status: 'incomparable' }>['reason']) =>
    backtestCostPairSchema.parse({ ...base, status: 'incomparable', reason, comparison: null });
  if (left.reportHash === right.reportHash) return incomparable('SAME_REPORT');
  const a = left.report,
    b = right.report;
  if (
    left.dataset.contentHash !== right.dataset.contentHash ||
    a.currency !== b.currency ||
    JSON.stringify(a.datasetRequest) !== JSON.stringify(b.datasetRequest)
  )
    return incomparable('DIFFERENT_DATASET');
  if (JSON.stringify(a.strategy) !== JSON.stringify(b.strategy)) return incomparable('DIFFERENT_STRATEGY');
  const executionFields = ['initialCash', 'quantity', 'priceTick'] as const;
  if (executionFields.some((field) => !new Decimal(a.config[field]).eq(b.config[field])))
    return incomparable('DIFFERENT_EXECUTION');
  const row = (artifact: BacktestArtifact): BacktestCostComparisonRow => ({
    dataset: artifact.dataset.contentHash,
    // Algorithm grouping only; individual artifacts have no research/validation classification.
    role: 'research',
    variant: artifact.reportHash,
    reportHash: artifact.reportHash,
    config: { strategy: artifact.report.strategy.parameters, execution: artifact.report.config },
    metrics: artifact.report.metrics,
    executionEvidence: { fills: artifact.report.fills, signals: artifact.report.signals },
  });
  const result = compareBacktestCosts([row(left), row(right)])[0];
  if (!result) return incomparable('COSTS_NOT_ORDERED');
  const {
    lowerReportHash,
    higherReportHash,
    netPnlDelta,
    feesDelta,
    lowerFillCount,
    higherFillCount,
    sameFillCount,
    changedCostFields,
    sameFillTimingAndQuantity,
    sameSignalDecisions,
    interpretation,
  } = result;
  return backtestCostPairSchema.parse({
    ...base,
    status: 'compared',
    reason: null,
    comparison: {
      lowerReportHash,
      higherReportHash,
      netPnlDelta,
      feesDelta,
      lowerFillCount,
      higherFillCount,
      sameFillCount,
      changedCostFields,
      sameFillTimingAndQuantity,
      sameSignalDecisions,
      interpretation,
    },
  });
}
