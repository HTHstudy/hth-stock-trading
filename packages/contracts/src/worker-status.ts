import { z } from 'zod';
export const workerRuntimeSchema = z
  .object({
    formatVersion: z.literal('worker-runtime-v1'),
    bootId: z.uuid(),
    mode: z.enum(['idle', 'observe', 'paper']),
    source: z.enum(['synthetic-only', 'toss-readonly']),
    state: z.enum([
      'idle',
      'starting',
      'observing',
      'paused',
      'waiting',
      'completed',
      'failed',
      'stopped',
      'awaiting-request',
    ]),
    startedAt: z.iso.datetime({ offset: true }),
    heartbeatAt: z.iso.datetime({ offset: true }),
    lastProgressAt: z.iso.datetime({ offset: true }).nullable(),
    intervalSeconds: z.number().int().min(10).max(3600),
    code: z.enum(['WORKER_OPERATION_FAILED', 'WORKER_STATUS_FAILED', 'REQUEST_ALREADY_CONSUMED']).nullable(),
    executionEnabled: z.literal(false),
  })
  .strict();
export const workerStatusSchema = z
  .object({
    asOf: z.iso.datetime({ offset: true }),
    availability: z.enum(['unavailable', 'fresh', 'stale', 'clock-unverified']),
    progress: z.enum(['not-required', 'pending', 'recent', 'overdue', 'unknown']),
    runtime: workerRuntimeSchema.nullable(),
    executionEnabled: z.literal(false),
  })
  .strict();
export type WorkerRuntime = z.infer<typeof workerRuntimeSchema>;
export type WorkerStatus = z.infer<typeof workerStatusSchema>;
