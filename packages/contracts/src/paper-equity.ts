import { z } from 'zod';
import { paperDataSourceSchema } from './paper-source.js';
import { strategyRevisionSchema } from './paper-strategy.js';

const amount = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/)
  .max(160);
export const paperEquityPointSchema = z
  .object({
    formatVersion: z.literal('paper-equity-v1'),
    version: strategyRevisionSchema,
    source: paperDataSourceSchema,
    recordedAt: z.iso.datetime({ offset: true }),
    observedAt: z.iso.datetime({ offset: true }),
    reconciled: z.boolean(),
    stale: z.boolean(),
    values: z.tuple([
      z.object({ currency: z.literal('KRW'), equity: amount }).strict(),
      z.object({ currency: z.literal('USD'), equity: amount }).strict(),
    ]),
  })
  .strict();
export const paperEquityHistorySchema = z
  .object({
    mode: z.literal('paper'),
    executionEnabled: z.literal(false),
    source: paperDataSourceSchema,
    baseline: paperEquityPointSchema.nullable(),
    points: z
      .array(
        z
          .object({
            point: paperEquityPointSchema,
            changePercent: z.tuple([amount.nullable(), amount.nullable()]),
          })
          .strict(),
      )
      .max(500),
    limited: z.boolean(),
  })
  .strict()
  .refine((value) => {
    if (!value.baseline) return value.points.length === 0 && !value.limited;
    return (
      value.baseline.source === value.source &&
      value.points.length > 0 &&
      value.points.every(
        ({ point }, index) =>
          point.source === value.source &&
          point.version >= value.baseline!.version &&
          (index === 0 || point.version > value.points[index - 1]!.point.version),
      )
    );
  });
export type PaperEquityPoint = z.infer<typeof paperEquityPointSchema>;
export type PaperEquityHistory = z.infer<typeof paperEquityHistorySchema>;
