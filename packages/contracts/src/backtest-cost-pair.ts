import { z } from 'zod';
import { reportHashSchema } from './backtest-reports.js';

const delta = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/)
  .max(800);
const comparison = z
  .object({
    lowerReportHash: reportHashSchema,
    higherReportHash: reportHashSchema,
    netPnlDelta: delta,
    feesDelta: delta,
    lowerFillCount: z.number().int().min(0).max(20_000),
    higherFillCount: z.number().int().min(0).max(20_000),
    sameFillCount: z.boolean(),
    changedCostFields: z
      .array(z.enum(['buyFeeBps', 'sellFeeBps', 'sellTaxBps', 'slippageBps']))
      .min(1)
      .max(4),
    sameFillTimingAndQuantity: z.boolean().nullable(),
    sameSignalDecisions: z.boolean().nullable(),
    interpretation: z.literal('MODELED_COST_SCENARIO_COMPARISON'),
  })
  .strict();

const base = z.object({
  formatVersion: z.literal('backtest-cost-pair-v1'),
  leftReportHash: reportHashSchema,
  rightReportHash: reportHashSchema,
  currency: z.enum(['KRW', 'USD']),
  executionEnabled: z.literal(false),
  canResume: z.literal(false),
});
export const backtestCostPairSchema = z
  .discriminatedUnion('status', [
    base.extend({ status: z.literal('compared'), reason: z.null(), comparison }).strict(),
    base
      .extend({
        status: z.literal('incomparable'),
        reason: z.enum([
          'SAME_REPORT',
          'DIFFERENT_DATASET',
          'DIFFERENT_STRATEGY',
          'DIFFERENT_EXECUTION',
          'COSTS_NOT_ORDERED',
        ]),
        comparison: z.null(),
      })
      .strict(),
  ])
  .refine(
    (pair) => {
      if (pair.status !== 'compared') return true;
      const value = pair.comparison;
      const hashesMatch =
        value.lowerReportHash !== value.higherReportHash &&
        ((value.lowerReportHash === pair.leftReportHash && value.higherReportHash === pair.rightReportHash) ||
          (value.lowerReportHash === pair.rightReportHash && value.higherReportHash === pair.leftReportHash));
      const equalCounts = value.lowerFillCount === value.higherFillCount;
      const zeroFills = value.lowerFillCount === 0 && value.higherFillCount === 0;
      return (
        hashesMatch &&
        value.sameFillCount === equalCounts &&
        (!zeroFills || value.sameFillTimingAndQuantity === null) &&
        (equalCounts || value.sameFillTimingAndQuantity !== true) &&
        new Set(value.changedCostFields).size === value.changedCostFields.length
      );
    },
    { message: 'Inconsistent backtest cost comparison' },
  );
export type BacktestCostPair = z.infer<typeof backtestCostPairSchema>;
