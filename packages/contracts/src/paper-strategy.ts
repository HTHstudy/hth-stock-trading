import { z } from 'zod';
import { movingAverageConfigSchema } from './backtest.js';
import { paperOrderCandidateSchema } from './risk.js';

export const strategyRevisionSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER - 2);
export const paperStrategyDefinitionSchema = z
  .object({
    kind: z.literal('moving-average-cross'),
    instrument: paperOrderCandidateSchema.shape.instrument,
    parameters: movingAverageConfigSchema,
    quantity: paperOrderCandidateSchema.shape.quantity,
    maxFillQuantity: paperOrderCandidateSchema.shape.quantity,
  })
  .strict()
  .refine((definition) => BigInt(definition.maxFillQuantity) <= BigInt(definition.quantity));
export const paperStrategyViewSchema = z
  .object({
    id: paperOrderCandidateSchema.shape.strategyId,
    version: z.string().min(1).max(40),
    enabled: z.boolean(),
    revision: strategyRevisionSchema.default(0),
    definition: paperStrategyDefinitionSchema.nullable().default(null),
  })
  .strict();
export const paperStrategyUpdateSchema = z
  .object({ expectedRevision: strategyRevisionSchema, enabled: z.boolean(), definition: paperStrategyDefinitionSchema })
  .strict();
export const paperStrategyAcknowledgementSchema = z
  .object({
    mode: z.literal('paper'),
    stopped: z.literal(true),
    executionEnabled: z.literal(false),
    strategy: paperStrategyViewSchema,
  })
  .strict();
export type PaperStrategyDefinition = z.infer<typeof paperStrategyDefinitionSchema>;
