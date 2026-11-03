import { z } from 'zod';
import {
  paperDiagnosticBatchSchema,
  paperDiagnosticCodeSchema,
  paperDiagnosticReportSchema,
} from './paper-diagnostics.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().min(0).max(500000);
// Private server artifact. Only the projected summary is returned over HTTP.
export const paperRunDiagnosticsArtifactSchema = z
  .object({
    formatVersion: z.literal('paper-run-diagnostics-v1'),
    beforeHash: hash,
    afterHash: hash,
    scope: hash,
    capturedAt: z.iso.datetime({ offset: true }),
    events: z.array(z.object({ key: hash, batch: paperDiagnosticBatchSchema, batchHash: hash }).strict()).max(5000),
    hash,
  })
  .strict();
export const paperRunDiagnosticsSummarySchema = z
  .object({
    availability: z.enum(['available', 'unavailable']),
    recordedBatches: z.number().int().min(0).max(5000),
    recordedReports: count,
    actions: z.object({ BUY: count, SELL: count, HOLD: count, unevaluated: count }).strict(),
    stages: z.partialRecord(paperDiagnosticReportSchema.shape.stage, count),
    reasons: z
      .array(z.object({ code: paperDiagnosticCodeSchema, count: z.number().int().min(1).max(500000) }).strict())
      .max(paperDiagnosticCodeSchema.options.length),
  })
  .strict()
  .refine((value) => new Set(value.reasons.map((reason) => reason.code)).size === value.reasons.length)
  .refine(
    (value) =>
      value.recordedBatches <= value.recordedReports &&
      value.recordedReports <= value.recordedBatches * 100 &&
      value.reasons.every((reason) => reason.count <= value.recordedReports),
  )
  .refine((value) =>
    value.availability === 'unavailable'
      ? value.recordedBatches === 0 &&
        value.recordedReports === 0 &&
        Object.values(value.actions).every((n) => n === 0) &&
        Object.keys(value.stages).length === 0 &&
        value.reasons.length === 0
      : Object.values(value.actions).reduce((sum, n) => sum + n, 0) === value.recordedReports &&
        Object.values(value.stages).reduce((sum, n) => sum + n, 0) === value.recordedReports,
  );
export type PaperRunDiagnosticsArtifact = z.infer<typeof paperRunDiagnosticsArtifactSchema>;
export type PaperRunDiagnosticsSummary = z.infer<typeof paperRunDiagnosticsSummarySchema>;
