import { z } from 'zod';
import { backtestConfigSchema, movingAverageConfigSchema } from './backtest.js';
import { historicalRequestSchema } from './historical.js';

const decimal = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/)
  .max(400);
const instant = z.iso.datetime({ offset: true });
const count = z.number().int().min(0).max(40_001);
export const reportHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const dataset = z
  .object({
    id: z.uuid().nullable(),
    contentHash: reportHashSchema,
    source: z.enum(['synthetic-demo', 'file', 'database']),
  })
  .strict();
const strategy = z
  .object({ id: z.literal('moving-average-cross'), version: z.literal('1.0.0'), parameters: movingAverageConfigSchema })
  .strict();
const metrics = z
  .object({
    initialCash: decimal,
    endingCash: decimal,
    endingQuantity: decimal,
    endingEquity: decimal,
    netPnl: decimal,
    realizedPnl: decimal,
    unrealizedPnl: decimal,
    cumulativeReturnPct: decimal,
    maxDrawdownPct: decimal,
    winRatePct: decimal.nullable(),
    tradeCount: count,
    fillCount: count,
    totalFees: decimal,
    totalTax: decimal,
  })
  .strict();
export function createBacktestReportSchema<T extends z.ZodType>(strategySchema: T) {
  return z
    .object({
      formatVersion: z.literal('backtest-report-v1'),
      engineVersion: z.enum(['1.0.0', '1.1.0']),
      mode: z.literal('paper'),
      executionEnabled: z.literal(false),
      model: z.enum(['next-eligible-open-v1', 'next-eligible-open-rules-v1']),
      strategy: strategySchema,
      config: backtestConfigSchema,
      currency: z.enum(['KRW', 'USD']),
      datasetRequest: historicalRequestSchema,
      pointInTime: z.literal(false),
      warnings: z.array(z.string().min(1).max(200)).max(30),
      signals: z
        .array(
          z
            .object({
              barTimestamp: instant,
              evaluatedAt: instant,
              action: z.enum(['BUY', 'SELL', 'HOLD']),
              reason: z.string().min(1).max(200),
              status: z.enum([
                'HOLD',
                'PENDING',
                'FILLED',
                'INSUFFICIENT_CASH',
                'INVALID_PRICE',
                'ALREADY_LONG',
                'NO_POSITION',
                'SUPERSEDED',
                'PENDING_EXISTS',
                'UNFILLED_END',
              ]),
            })
            .strict(),
        )
        .max(20_000),
      fills: z
        .array(
          z
            .object({
              signalIndex: count,
              action: z.enum(['BUY', 'SELL']),
              timestamp: instant,
              barTimestamp: instant,
              referencePrice: decimal,
              price: decimal,
              quantity: decimal,
              notional: decimal,
              fee: decimal,
              tax: decimal,
              cashAfter: decimal,
            })
            .strict(),
        )
        .max(20_000),
      trades: z.array(z.object({ entryFill: count, exitFill: count, netPnl: decimal }).strict()).max(10_000),
      equity: z
        .array(
          z
            .object({
              timestamp: instant,
              kind: z.enum(['initial', 'open', 'close']),
              equity: decimal,
              cash: decimal,
              quantity: decimal,
              cumulativeReturnPct: decimal,
            })
            .strict(),
        )
        .min(1)
        .max(40_001),
      metrics,
    })
    .strict()
    .refine(
      (value) =>
        value.config.executionRules === undefined
          ? value.model === 'next-eligible-open-v1' && value.engineVersion === '1.0.0'
          : value.model === 'next-eligible-open-rules-v1' && value.engineVersion === '1.1.0',
      { message: 'Execution rules, model and engine version must match' },
    )
    .refine(
      (value) =>
        value.metrics.fillCount === value.fills.length &&
        value.metrics.tradeCount === value.trades.length &&
        value.fills.every((fill) => fill.signalIndex < value.signals.length) &&
        value.trades.every((trade) => trade.entryFill < value.fills.length && trade.exitFill < value.fills.length),
    );
}

export const backtestReportSchema = createBacktestReportSchema(strategy);

export const backtestArtifactSchema = z
  .object({
    reportHash: reportHashSchema,
    formatVersion: z.literal('backtest-artifact-v1'),
    dataset,
    report: backtestReportSchema,
  })
  .strict();
export const backtestSummarySchema = z
  .object({
    reportHash: reportHashSchema,
    dataset,
    strategy,
    config: backtestConfigSchema,
    currency: z.enum(['KRW', 'USD']),
    datasetRequest: historicalRequestSchema,
    metrics,
  })
  .strict();
export const backtestListSchema = z
  .object({ reports: z.array(backtestSummarySchema).max(100), rejectedCount: count, limited: z.boolean() })
  .strict();
export type BacktestArtifact = z.infer<typeof backtestArtifactSchema>;
export type BacktestSummary = z.infer<typeof backtestSummarySchema>;
export type BacktestList = z.infer<typeof backtestListSchema>;
