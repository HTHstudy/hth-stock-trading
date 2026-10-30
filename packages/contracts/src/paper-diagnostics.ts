import { z } from 'zod';
import { dataBlockerSchema } from './market-data.js';
import { riskBlockerSchema, paperOrderCandidateSchema } from './risk.js';
import { paperStrategyViewSchema, strategyRevisionSchema } from './paper-strategy.js';
import { paperDataSourceSchema } from './paper-source.js';
import { paperIntentStateSchema } from './paper-ledger.js';
export const paperDiagnosticCodeSchema = z.enum([
  ...dataBlockerSchema.options,
  ...riskBlockerSchema.options,
  'ACCOUNT_PAUSED',
  'WARMUP',
  'NO_CROSS',
  'BULLISH_CROSS',
  'BEARISH_CROSS',
  'ALREADY_OWNED',
  'NO_OWNED_QUANTITY',
  'DUPLICATE_SIGNAL',
  'ORDER_RESERVED',
  'WORKER_ERROR',
  'SOURCE_UNAVAILABLE',
  'EXECUTION_CANCELLED',
  'HEARTBEAT_FAILED',
]);
export const paperDiagnosticReportSchema = z
  .object({
    strategyId: paperOrderCandidateSchema.shape.strategyId,
    strategyVersion: z.string().min(1).max(40),
    strategyRevision: strategyRevisionSchema,
    instrument: paperOrderCandidateSchema.shape.instrument,
    evaluatedAt: z.iso.datetime({ offset: true }),
    stage: z.enum(['control', 'source', 'data', 'fill', 'strategy', 'reservation']),
    action: z.enum(['BUY', 'SELL', 'HOLD']).nullable(),
    codes: z.array(paperDiagnosticCodeSchema).min(1).max(100),
    closedCandles: z.number().int().min(0).max(10000).nullable(),
    barAt: z.iso.datetime({ offset: true }).nullable(),
    orderState: paperIntentStateSchema.nullable(),
  })
  .strict()
  .refine((report) => {
    if (['control', 'source', 'data', 'fill'].includes(report.stage) && report.action !== null) return false;
    if (report.orderState !== null && (report.stage !== 'reservation' || report.action === 'HOLD')) return false;
    return report.closedCandles !== null || (report.action === null && report.barAt === null);
  });
export const paperDiagnosticBatchSchema = z
  .object({
    formatVersion: z.literal('paper-diagnostics-v1'),
    recordedAt: z.iso.datetime({ offset: true }),
    source: paperDataSourceSchema,
    epoch: strategyRevisionSchema,
    accountVersion: strategyRevisionSchema,
    reports: z.array(paperDiagnosticReportSchema).min(1).max(100),
  })
  .strict()
  .refine((value) => new Set(value.reports.map((r) => r.strategyId)).size === value.reports.length);
export const paperDiagnosticsSchema = z
  .object({
    mode: z.literal('paper'),
    executionEnabled: z.literal(false),
    source: paperDataSourceSchema,
    asOf: z.iso.datetime({ offset: true }),
    stopped: z.boolean(),
    workerState: z.enum(['active', 'expired', 'absent']),
    items: z
      .array(
        z
          .object({
            strategy: paperStrategyViewSchema,
            latest: z
              .object({ report: paperDiagnosticReportSchema, recordedAt: z.iso.datetime({ offset: true }) })
              .strict()
              .nullable(),
            configurationCurrent: z.boolean().nullable(),
            stale: z.boolean().nullable(),
          })
          .strict(),
      )
      .max(100),
    limited: z.boolean(),
  })
  .strict()
  .refine((value) =>
    value.items.every((item) =>
      item.latest === null
        ? item.configurationCurrent === null && item.stale === null
        : item.latest.report.strategyId === item.strategy.id &&
          item.configurationCurrent !== null &&
          item.stale !== null,
    ),
  );
export type PaperDiagnosticReport = z.infer<typeof paperDiagnosticReportSchema>;
export type PaperDiagnostics = z.infer<typeof paperDiagnosticsSchema>;
