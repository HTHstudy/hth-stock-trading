import { z } from 'zod';
import { backtestArtifactSchema, reportHashSchema } from './backtest-reports.js';
import { backtestConfigSchema, movingAverageConfigSchema } from './backtest.js';
import { channelBreakoutConfigSchema, meanReversionConfigSchema } from './research-strategies.js';
import { historicalRequestSchema } from './historical.js';
import { buyAndHoldConfigSchema } from './benchmark-strategy.js';

const name = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const amount = z
  .string()
  .regex(/^\d+(\.\d+)?$/)
  .max(400);
const signed = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/)
  .max(400);
const duration = z.number().int().min(0).max(40_000_000_000);
const count = z.number().int().min(0).max(40_001);
const benchmarkStrategyConfigSchema = buyAndHoldConfigSchema;
export const researchStrategyDefinitionSchema = z.discriminatedUnion('id', [
  z
    .object({
      id: z.literal('moving-average-cross'),
      version: z.literal('1.0.0'),
      parameters: movingAverageConfigSchema,
    })
    .strict(),
  z
    .object({ id: z.literal('channel-breakout'), version: z.literal('1.0.0'), parameters: channelBreakoutConfigSchema })
    .strict(),
  z
    .object({ id: z.literal('mean-reversion'), version: z.literal('1.0.0'), parameters: meanReversionConfigSchema })
    .strict(),
  z
    .object({ id: z.literal('buy-and-hold'), version: z.literal('1.0.0'), parameters: benchmarkStrategyConfigSchema })
    .strict(),
]);
function atMost(left: string, right: string): boolean {
  if (![left, right].every((value) => value.length <= 400 && /^\d+(\.\d+)?$/.test(value))) return false;
  const [a = '', af = ''] = left.split('.'),
    [b = '', bf = ''] = right.split('.');
  const scale = Math.max(af.length, bf.length);
  return BigInt(a + af.padEnd(scale, '0')) <= BigInt(b + bf.padEnd(scale, '0'));
}

const isZero = (value: string) => !/[1-9]/.test(value);

export const capitalExposureSchema = z
  .object({
    model: z.literal('acquisition-cost-calendar-time-v1'),
    windowStartAt: z.iso.datetime({ offset: true }),
    windowEndAt: z.iso.datetime({ offset: true }),
    windowMilliseconds: duration,
    holdingMilliseconds: duration,
    holdingPct: amount,
    maxInvestedCapital: amount,
    averageInvestedCapital: amount,
    netPnlOverMaxInvestedCapitalPct: signed.nullable(),
    totalBuyNotional: amount,
    totalSellNotional: amount,
  })
  .strict()
  .refine(
    (value) =>
      value.holdingMilliseconds <= value.windowMilliseconds &&
      Date.parse(value.windowEndAt) - Date.parse(value.windowStartAt) === value.windowMilliseconds &&
      atMost(value.holdingPct, '100') &&
      atMost(value.averageInvestedCapital, value.maxInvestedCapital) &&
      (/[1-9]/.test(value.maxInvestedCapital) || value.netPnlOverMaxInvestedCapitalPct === null),
  );

const datasetSchema = z
  .object({ id: name, role: z.enum(['research', 'validation']), request: historicalRequestSchema })
  .strict();
const rowSchema = z
  .object({
    dataset: name,
    variant: name,
    kind: z.enum(['strategy', 'benchmark']),
    strategy: researchStrategyDefinitionSchema,
    execution: backtestConfigSchema,
    reportHash: reportHashSchema,
    tradePathObserved: z.boolean(),
    warmupSignals: count,
    unfilledAtEnd: count,
    metrics: backtestArtifactSchema.shape.report.shape.metrics,
    exposure: capitalExposureSchema,
    comparisonStatus: z.enum(['benchmark', 'compared', 'strategy-no-fills', 'benchmark-no-fills']),
    benchmarkReportHash: reportHashSchema.nullable(),
    netPnlDifference: signed.nullable(),
  })
  .strict();
export const strategyResearchSnapshotSchema = z
  .object({
    formatVersion: z.literal('strategy-research-snapshot-v1'),
    snapshotHash: reportHashSchema,
    sourceResultHash: reportHashSchema,
    manifestHash: reportHashSchema,
    legacyStudyResultHash: reportHashSchema,
    mode: z.literal('paper'),
    executionEnabled: z.literal(false),
    pointInTime: z.literal(false),
    independentHoldoutVerified: z.literal(false),
    strategySelected: z.literal(false),
    artifactIntegrityVerified: z.literal(true),
    datasetFilesReverified: z.literal(false),
    engineReexecuted: z.literal(false),
    benchmark: benchmarkStrategyConfigSchema,
    datasets: z.array(datasetSchema).min(1).max(8),
    rows: z.array(rowSchema).min(1).max(32),
  })
  .strict()
  .superRefine((value, context) => {
    const datasets = new Map(value.datasets.map((entry) => [entry.id, entry]));
    const reports = new Map(value.rows.map((entry) => [entry.reportHash, entry]));
    const pairs = new Set(value.rows.map((entry) => `${entry.dataset}/${entry.variant}`));
    let valid =
      datasets.size === value.datasets.length && reports.size === value.rows.length && pairs.size === value.rows.length;
    const first = value.datasets[0]!.request;
    valid &&= value.datasets.every(
      ({ request }) =>
        request.instrument.market === first.instrument.market &&
        request.instrument.symbol === first.instrument.symbol &&
        request.interval === first.interval &&
        request.source === first.source &&
        request.adjusted === first.adjusted,
    );
    valid &&= value.datasets.every(
      ({ id }) =>
        value.rows.some((row) => row.dataset === id && row.kind === 'benchmark') &&
        value.rows.some((row) => row.dataset === id && row.kind === 'strategy'),
    );
    for (const row of value.rows) {
      valid &&= datasets.has(row.dataset) && row.tradePathObserved === row.metrics.fillCount > 0;
      if (row.metrics.fillCount === 0) {
        valid &&=
          row.exposure.holdingMilliseconds === 0 &&
          [
            row.exposure.holdingPct,
            row.exposure.maxInvestedCapital,
            row.exposure.averageInvestedCapital,
            row.exposure.totalBuyNotional,
            row.exposure.totalSellNotional,
            row.metrics.netPnl,
            row.metrics.endingQuantity,
            row.metrics.realizedPnl,
            row.metrics.unrealizedPnl,
            row.metrics.totalFees,
            row.metrics.totalTax,
            row.metrics.cumulativeReturnPct,
            row.metrics.maxDrawdownPct,
          ].every(isZero) &&
          row.exposure.netPnlOverMaxInvestedCapitalPct === null &&
          row.metrics.tradeCount === 0 &&
          row.metrics.winRatePct === null &&
          atMost(row.metrics.initialCash, row.metrics.endingCash) &&
          atMost(row.metrics.endingCash, row.metrics.initialCash) &&
          atMost(row.metrics.initialCash, row.metrics.endingEquity) &&
          atMost(row.metrics.endingEquity, row.metrics.initialCash);
      }
      if (row.kind === 'benchmark') {
        valid &&=
          row.strategy.id === 'buy-and-hold' &&
          row.comparisonStatus === 'benchmark' &&
          row.benchmarkReportHash === null &&
          row.netPnlDifference === null &&
          row.strategy.parameters.entryAfterClosedCandles === value.benchmark.entryAfterClosedCandles;
      } else {
        const baseline = row.benchmarkReportHash ? reports.get(row.benchmarkReportHash) : undefined;
        valid &&=
          row.strategy.id !== 'buy-and-hold' &&
          baseline?.kind === 'benchmark' &&
          baseline.dataset === row.dataset &&
          JSON.stringify(baseline.execution) === JSON.stringify(row.execution) &&
          (row.comparisonStatus === 'compared'
            ? row.tradePathObserved && baseline.tradePathObserved && row.netPnlDifference !== null
            : row.netPnlDifference === null &&
              (row.comparisonStatus === 'strategy-no-fills'
                ? !row.tradePathObserved
                : row.comparisonStatus === 'benchmark-no-fills' &&
                  row.tradePathObserved &&
                  !baseline.tradePathObserved));
      }
    }
    if (!valid) context.addIssue({ code: 'custom', message: 'Inconsistent research snapshot' });
  });
export const strategyResearchSummarySchema = z
  .object({
    snapshotHash: reportHashSchema,
    sourceResultHash: reportHashSchema,
    instrument: historicalRequestSchema.shape.instrument,
    interval: historicalRequestSchema.shape.interval,
    currency: z.enum(['KRW', 'USD']),
    periods: z.number().int().min(1).max(8),
    rows: z.number().int().min(1).max(32),
  })
  .strict();
export const strategyResearchListSchema = z
  .object({
    reports: z.array(strategyResearchSummarySchema).max(100),
    rejectedCount: count,
    limited: z.boolean(),
  })
  .strict();
export type CapitalExposure = z.infer<typeof capitalExposureSchema>;
export type StrategyResearchSnapshot = z.infer<typeof strategyResearchSnapshotSchema>;
export type StrategyResearchSummary = z.infer<typeof strategyResearchSummarySchema>;
export type StrategyResearchList = z.infer<typeof strategyResearchListSchema>;
