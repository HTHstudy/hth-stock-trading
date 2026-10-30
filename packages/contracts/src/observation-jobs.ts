import { z } from 'zod';
import { observationFailureSchema } from './observation.js';
import { paperOrderCandidateSchema } from './risk.js';

export const observationJobSchema = z
  .object({
    id: z
      .string()
      .regex(/^(kr|us)-\d{4}-\d{2}-\d{2}(?:-retry-[1-9][0-9]?)?$/)
      .refine((value) => z.iso.date().safeParse(value.slice(3, 13)).success),
    startsAt: z.iso.datetime({ offset: true }),
    launchedAt: z.iso.datetime({ offset: true }),
    instrument: paperOrderCandidateSchema.shape.instrument,
    requestedSamples: z.number().int().min(1).max(10000),
    intervalSeconds: z.number().int().min(10).max(3600),
    state: z.enum(['scheduled', 'awaiting-result', 'failed', 'cancelled', 'completed']),
    failureCode: observationFailureSchema.shape.failure.shape.code.nullable(),
    reportId: z.uuid().nullable(),
    recordedSamples: z.number().int().min(0).max(10000).nullable(),
    executionEnabled: z.literal(false),
  })
  .strict()
  .refine((job) => {
    if (!job.id.startsWith(job.instrument.market.toLowerCase() + '-')) return false;
    if (job.recordedSamples !== null && job.recordedSamples > job.requestedSamples) return false;
    if (job.failureCode !== null)
      return job.state === 'failed' && job.reportId === null && job.recordedSamples === null;
    if (job.reportId !== null)
      return (
        ['completed', 'failed', 'cancelled'].includes(job.state) &&
        job.recordedSamples !== null &&
        (job.state !== 'completed' || job.recordedSamples === job.requestedSamples)
      );
    return job.recordedSamples === null && ['scheduled', 'awaiting-result', 'cancelled'].includes(job.state);
  });
export const observationJobsSchema = z
  .object({
    asOf: z.iso.datetime({ offset: true }),
    jobs: z.array(observationJobSchema).max(20),
    rejectedCount: z.number().int().nonnegative().max(100),
    limited: z.boolean(),
  })
  .strict();
export type ObservationJobs = z.infer<typeof observationJobsSchema>;
