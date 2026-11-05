import { Decimal } from 'decimal.js';
import type { z } from 'zod';
import type { backtestArtifactSchema, movingAverageBacktestConfigSchema } from '@hth/contracts';

export type MovingAverageBacktestConfig = z.infer<typeof movingAverageBacktestConfigSchema>;
export type BacktestCostComparisonRow = {
  dataset: string;
  role: 'research' | 'validation';
  variant: string;
  config: MovingAverageBacktestConfig;
  reportHash: string;
  metrics: z.infer<typeof backtestArtifactSchema>['report']['metrics'];
};
export type BacktestCostComparison = {
  dataset: string;
  role: 'research' | 'validation';
  lowerCostVariant: string;
  higherCostVariant: string;
  lowerReportHash: string;
  higherReportHash: string;
  netPnlDelta: string;
  feesDelta: string;
  lowerFillCount: number;
  higherFillCount: number;
  sameFillCount: boolean;
  interpretation: 'MODELED_COST_SCENARIO_COMPARISON';
};

// Isolated from global Decimal settings. Two 400-character metric strings can
// span nearly 800 significant places when their decimal points differ.
const Money = Decimal.clone({ precision: 800, toExpNeg: -800, toExpPos: 800 });
const costFields = ['buyFeeBps', 'sellFeeBps', 'sellTaxBps', 'slippageBps'] as const;

function groupKey(row: BacktestCostComparisonRow): string {
  const { strategy, execution } = row.config;
  return JSON.stringify([
    row.dataset,
    row.role,
    strategy.fastPeriod,
    strategy.slowPeriod,
    new Money(execution.initialCash).toString(),
    new Money(execution.quantity).toString(),
    new Money(execution.priceTick).toString(),
  ]);
}

/** Validated review rows only; scenario deltas do not establish fee-only causality
 * or profitability rankings, even when fill counts match. Zero-trade pairs remain
 * explicit comparisons with their actual (possibly zero) deltas.
 */
export function compareBacktestCosts(rows: readonly BacktestCostComparisonRow[]): BacktestCostComparison[] {
  const groups = new Map<string, BacktestCostComparisonRow[]>();
  for (const row of rows) {
    const key = groupKey(row);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  const comparisons: BacktestCostComparison[] = [];
  for (const group of groups.values()) {
    for (const [index, first] of group.entries()) {
      for (const second of group.slice(index + 1)) {
        const directions = costFields.map((field) =>
          new Money(first.config.execution[field]).comparedTo(second.config.execution[field]),
        );
        const firstIsLower = directions.every((value) => value <= 0) && directions.some((value) => value < 0);
        const secondIsLower = directions.every((value) => value >= 0) && directions.some((value) => value > 0);
        if (!firstIsLower && !secondIsLower) continue;
        const [lower, higher] = firstIsLower ? [first, second] : [second, first];
        comparisons.push({
          dataset: lower.dataset,
          role: lower.role,
          lowerCostVariant: lower.variant,
          higherCostVariant: higher.variant,
          lowerReportHash: lower.reportHash,
          higherReportHash: higher.reportHash,
          netPnlDelta: new Money(higher.metrics.netPnl).minus(lower.metrics.netPnl).toFixed(),
          feesDelta: new Money(higher.metrics.totalFees).minus(lower.metrics.totalFees).toFixed(),
          lowerFillCount: lower.metrics.fillCount,
          higherFillCount: higher.metrics.fillCount,
          sameFillCount: lower.metrics.fillCount === higher.metrics.fillCount,
          interpretation: 'MODELED_COST_SCENARIO_COMPARISON',
        });
      }
    }
  }
  return comparisons;
}
