import { z } from 'zod';
import { observationJobSchema, paperValidationFailureCodeSchema } from '@hth/contracts';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().min(0).max(5000);
export const paperValidationRequestSchema = z
  .object({
    formatVersion: z.literal('authorized-paper-validation-v1'),
    market: z.enum(['KR', 'US']),
    prerequisite: observationJobSchema.shape.id,
    startsAt: z.iso.datetime({ offset: true }).nullable(),
    deadline: z.iso.datetime({ offset: true }),
    resumeRequested: z.literal(true),
    maxTicks: z.literal(60),
    buildHash: hash,
    expectedControlHash: hash.nullable().optional(),
    resourcesHash: hash.optional(),
    continuation: z.strictObject({ parentRunId: z.uuid(), parentLaunchId: z.uuid(), evidenceHash: hash }).optional(),
    automaticRetry: z.literal(false),
    executionEnabled: z.literal(false),
  })
  .strict()
  .refine(
    (value) =>
      value.prerequisite.startsWith(value.market.toLowerCase() + '-') &&
      (value.startsAt === null || Date.parse(value.startsAt) < Date.parse(value.deadline)),
  );
export const paperValidationResultSchema = z
  .object({
    formatVersion: z.literal('authorized-paper-validation-result-v1'),
    market: z.enum(['KR', 'US']),
    state: z.enum([
      'completed',
      'completed-with-incomplete-review',
      'execution-ended-early',
      'review-issues-found',
      'stopped-before-run-or-failed',
    ]),
    resumeRequested: z.literal(true),
    maxTicks: z.literal(60),
    completedTicks: z.number().int().min(0).max(60),
    runningTicks: z.number().int().min(0).max(60).optional(),
    verdict: z.enum(['issues-found', 'incomplete', 'consistent-observed-state']).optional(),
    stoppedAndCleaned: z.boolean().nullable().optional(),
    intents: count.optional(),
    fills: count.optional(),
    finishedAt: z.iso.datetime({ offset: true }),
    executionEnabled: z.literal(false),
    automaticRetry: z.literal(false),
    runStarted: z.boolean().optional(),
    phase: z
      .enum(['waiting', 'account-preflight', 'daily-review', 'stopped-observation', 'authorized-paper-run'])
      .optional(),
    code: paperValidationFailureCodeSchema.optional(),
  })
  .strict()
  .refine((value) => value.runningTicks === undefined || value.runningTicks <= value.completedTicks);
