import { z } from 'zod';
import { paperDataSourceSchema } from './paper-source.js';
import { paperStrategyDefinitionSchema, paperStrategyViewSchema, strategyRevisionSchema } from './paper-strategy.js';

export const paperStrategyHistoryQuerySchema = z
  .object({
    beforeRevision: z.coerce
      .number()
      .int()
      .min(1)
      .max(Number.MAX_SAFE_INTEGER - 2)
      .optional(),
  })
  .strict();
export const paperStrategyHistoryEntrySchema = z
  .object({
    revision: strategyRevisionSchema.min(1),
    version: z.string().min(1).max(40),
    enabled: z.boolean(),
    definition: paperStrategyDefinitionSchema.nullable(),
    actor: z.enum(['owner', 'system']),
    createdAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export const paperStrategyHistorySchema = z
  .object({
    mode: z.literal('paper'),
    executionEnabled: z.literal(false),
    source: paperDataSourceSchema,
    strategy: paperStrategyViewSchema,
    beforeRevision: strategyRevisionSchema.min(1).nullable(),
    entries: z.array(paperStrategyHistoryEntrySchema).max(20),
    nextBeforeRevision: strategyRevisionSchema.min(1).nullable(),
  })
  .strict()
  .refine((value) => {
    const first = Math.min(
      value.strategy.revision,
      value.beforeRevision === null ? value.strategy.revision : value.beforeRevision - 1,
    );
    return (
      value.entries.every((item, index) => item.revision === first - index) &&
      value.entries.length === Math.min(20, first) &&
      value.nextBeforeRevision === (first > 20 ? value.entries.at(-1)!.revision : null)
    );
  });
export type PaperStrategyHistory = z.infer<typeof paperStrategyHistorySchema>;
