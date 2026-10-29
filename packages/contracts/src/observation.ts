import { z } from 'zod';
import { dataBlockerSchema } from './market-data.js';
import { paperOrderCandidateSchema } from './risk.js';
export const observationErrorSchema = z.enum([
  'INVALID_INPUT',
  'INVALID_RESPONSE',
  'UNSUPPORTED_MARKET',
  'AUTHENTICATION_FAILED',
  'PERMISSION_DENIED',
  'RATE_LIMITED',
  'UPSTREAM_REJECTED',
  'UPSTREAM_UNAVAILABLE',
  'NETWORK_ERROR',
  'TIMEOUT',
  'CANCELLED',
  'OBSERVATION_TIMEOUT',
  'OBSERVATION_FAILED',
]);
export const observationRecordSchema = z
  .object({
    index: z.number().int().positive(),
    startedAt: z.iso.datetime({ offset: true }),
    finishedAt: z.iso.datetime({ offset: true }),
    durationMs: z.number().finite().nonnegative(),
    error: observationErrorSchema.nullable(),
    instruments: z
      .array(
        z
          .object({
            instrument: paperOrderCandidateSchema.shape.instrument,
            state: z.enum(['healthy', 'closed', 'blocked']),
            blockers: z.array(dataBlockerSchema),
            quoteTimestamp: z.iso.datetime({ offset: true }).nullable(),
            quoteAgeMs: z.number().finite().nullable(),
            quoteRegressed: z.boolean(),
            latestCandleAt: z.iso.datetime({ offset: true }).nullable(),
            closedCandles: z.number().int().nonnegative(),
            pendingCandles: z.number().int().nonnegative(),
            blockedCandles: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(5),
  })
  .strict();
export type ObservationRecord = z.infer<typeof observationRecordSchema>;
const count = z.number().int().nonnegative().max(50000);
const duration = z.number().finite().nonnegative();
const instrumentCounters = z
  .object({
    samples: count,
    healthy: count,
    closed: count,
    blocked: count,
    quoteRegressions: count,
    missingQuoteTimes: count,
    maxQuoteAgeMs: duration.nullable(),
  })
  .strict();
export const observationSummarySchema = z
  .object({
    samples: count,
    successfulSamples: count,
    errorSamples: count,
    healthy: count,
    closed: count,
    blocked: count,
    quoteRegressions: count,
    totalDurationMs: duration,
    maxDurationMs: duration,
    blockers: z.partialRecord(dataBlockerSchema, count),
    errors: z.partialRecord(observationErrorSchema, count),
    instruments: z
      .record(z.string().regex(/^(KR|US):[A-Z0-9.-]{1,40}$/), instrumentCounters)
      .refine((value) => Object.keys(value).length <= 5),
    status: z.enum(['completed', 'cancelled', 'failed']),
  })
  .strict();
export const observationManifestSchema = z
  .object({
    formatVersion: z.literal('market-observation-v1'),
    id: z.uuid(),
    startedAt: z.iso.datetime({ offset: true }),
    mode: z.literal('paper'),
    assessmentScope: z.literal('market-data-only'),
    executionEnabled: z.literal(false),
    policyVersion: z.literal('market-data-v1'),
    source: z.enum(['synthetic-only', 'toss-readonly']),
    instruments: z.array(paperOrderCandidateSchema.shape.instrument).min(1).max(5),
    samples: z.number().int().min(1).max(10000),
    intervalMs: z.number().int().min(0).max(3600000),
    timeoutMs: z.number().int().min(1).max(10000),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.instruments.map((item) => `${item.market}:${item.symbol}`)).size === value.instruments.length,
  );
const terminalFields = {
  finishedAt: z.iso.datetime({ offset: true }),
  journalSha256: z.string().regex(/^[a-f0-9]{64}$/),
};
export const observationArtifactSchema = observationManifestSchema.safeExtend({
  ...terminalFields,
  summary: observationSummarySchema,
});
export const observationFailureSchema = observationManifestSchema.safeExtend({
  ...terminalFields,
  summary: z.null(),
  failure: z
    .object({
      code: z.enum([
        ...observationErrorSchema.options,
        'BROKER_LEASE_BUSY',
        'BROKER_LEASE_LOST',
        'MARKET_OBSERVATION_CONFIGURATION_INVALID',
        'OBSERVATION_START_MISSED',
        'OBSERVATION_SESSION_UNAVAILABLE',
      ]),
    })
    .strict(),
});
const viewFields = {
  manifest: observationManifestSchema,
  state: z.enum(['completed', 'cancelled', 'failed', 'incomplete']),
  finishedAt: z.iso.datetime({ offset: true }).nullable(),
  journalSha256: terminalFields.journalSha256.nullable(),
  summary: observationSummarySchema.nullable(),
  failureCode: observationFailureSchema.shape.failure.shape.code.nullable(),
  recordedSamples: count,
};
const viewSchema = z.object(viewFields).strict();
function validView(value: z.infer<typeof viewSchema>) {
  if (value.recordedSamples > value.manifest.samples) return false;
  if (value.state === 'incomplete')
    return (
      value.summary === null &&
      value.journalSha256 === null &&
      value.finishedAt === null &&
      value.failureCode === null &&
      value.recordedSamples === 0
    );
  if (value.journalSha256 === null || value.finishedAt === null) return false;
  if (value.summary)
    return (
      value.summary.status === value.state &&
      value.recordedSamples === value.summary.samples &&
      value.failureCode === null &&
      (value.state !== 'completed' || value.recordedSamples === value.manifest.samples)
    );
  return value.state === 'failed' && value.failureCode !== null;
}
export const observationListItemSchema = viewSchema.refine(validView);
export const observationReportSchema = z
  .object({ ...viewFields, recentSamples: z.array(observationRecordSchema).max(50), samplesLimited: z.boolean() })
  .strict()
  .refine(validView)
  .refine((value) => {
    const hasOlderSamples = value.recordedSamples > 50;
    return (
      value.samplesLimited === hasOlderSamples && value.recentSamples.length === Math.min(50, value.recordedSamples)
    );
  });
export const observationListSchema = z
  .object({ reports: z.array(observationListItemSchema).max(50), rejectedCount: count, limited: z.boolean() })
  .strict();
export type ObservationReport = z.infer<typeof observationReportSchema>;
export type ObservationList = z.infer<typeof observationListSchema>;
