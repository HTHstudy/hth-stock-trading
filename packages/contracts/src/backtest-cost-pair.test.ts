import { expect, it } from 'vitest';
import { backtestCostPairSchema } from './backtest-cost-pair.js';

function pair() {
  return {
    formatVersion: 'backtest-cost-pair-v1',
    leftReportHash: 'a'.repeat(64),
    rightReportHash: 'b'.repeat(64),
    currency: 'KRW',
    executionEnabled: false,
    canResume: false,
    status: 'compared',
    reason: null,
    comparison: {
      lowerReportHash: 'a'.repeat(64),
      higherReportHash: 'b'.repeat(64),
      netPnlDelta: '0',
      feesDelta: '0',
      lowerFillCount: 2,
      higherFillCount: 2,
      sameFillCount: true,
      changedCostFields: ['buyFeeBps'],
      sameFillTimingAndQuantity: true as boolean | null,
      sameSignalDecisions: true,
      interpretation: 'MODELED_COST_SCENARIO_COMPARISON',
    },
  };
}

it('accepts either cost ordering of exactly the two distinct input hashes', () => {
  const value = pair();
  expect(backtestCostPairSchema.safeParse(value).success).toBe(true);
  [value.comparison.lowerReportHash, value.comparison.higherReportHash] = [
    value.comparison.higherReportHash,
    value.comparison.lowerReportHash,
  ];
  expect(backtestCostPairSchema.safeParse(value).success).toBe(true);
});
it.each(['lowerReportHash', 'higherReportHash'] as const)('rejects unrelated or duplicate %s', (field) => {
  const value = pair();
  value.comparison[field] = 'c'.repeat(64);
  expect(backtestCostPairSchema.safeParse(value).success).toBe(false);
  value.comparison[field] = value.comparison[field === 'lowerReportHash' ? 'higherReportHash' : 'lowerReportHash'];
  expect(backtestCostPairSchema.safeParse(value).success).toBe(false);
});
it('rejects identical input hashes for compared results', () => {
  const value = pair();
  value.rightReportHash = value.leftReportHash;
  expect(backtestCostPairSchema.safeParse(value).success).toBe(false);
});
it('requires sameFillCount to reflect counts and excludes true timing when counts differ', () => {
  const value = pair();
  value.comparison.sameFillCount = false;
  expect(backtestCostPairSchema.safeParse(value).success).toBe(false);
  value.comparison.higherFillCount = 1;
  expect(backtestCostPairSchema.safeParse(value).success).toBe(false);
  for (const timing of [false, null]) {
    value.comparison.sameFillTimingAndQuantity = timing;
    expect(backtestCostPairSchema.safeParse(value).success).toBe(true);
  }
  value.comparison.sameFillCount = true;
  expect(backtestCostPairSchema.safeParse(value).success).toBe(false);
});
it('requires unknown fill timing when both counts are zero', () => {
  const value = pair();
  value.comparison.lowerFillCount = 0;
  value.comparison.higherFillCount = 0;
  for (const timing of [true, false]) {
    value.comparison.sameFillTimingAndQuantity = timing;
    expect(backtestCostPairSchema.safeParse(value).success).toBe(false);
  }
  value.comparison.sameFillTimingAndQuantity = null;
  expect(backtestCostPairSchema.safeParse(value).success).toBe(true);
});
it('requires distinct changed cost fields and permits each of the four once', () => {
  const value = pair();
  value.comparison.changedCostFields = ['buyFeeBps', 'buyFeeBps'];
  expect(backtestCostPairSchema.safeParse(value).success).toBe(false);
  value.comparison.changedCostFields = ['buyFeeBps', 'sellFeeBps', 'sellTaxBps', 'slippageBps'];
  expect(backtestCostPairSchema.safeParse(value).success).toBe(true);
});
it('preserves incomparable responses without comparison evidence', () => {
  const value = { ...pair(), status: 'incomparable', reason: 'SAME_REPORT', comparison: null };
  value.rightReportHash = value.leftReportHash;
  expect(backtestCostPairSchema.safeParse(value).success).toBe(true);
});
