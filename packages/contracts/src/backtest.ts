import { z } from 'zod';

const amount = z
  .string()
  .regex(/^\d+(\.\d+)?$/)
  .max(30);
const positive = amount.refine((value) => /[1-9]/.test(value));
const basisPoints = amount.refine((value) => Number(value) < 10_000);

export const movingAverageConfigSchema = z
  .object({ fastPeriod: z.number().int().min(1).max(2000), slowPeriod: z.number().int().min(2).max(2000) })
  .strict()
  .refine((value) => value.fastPeriod < value.slowPeriod);
export const strategySignalSchema = z
  .object({ action: z.enum(['BUY', 'SELL', 'HOLD']), reason: z.string().min(1).max(200) })
  .strict();
export const backtestConfigSchema = z
  .object({
    initialCash: positive,
    quantity: z.string().regex(/^[1-9]\d{0,11}$/),
    priceTick: positive,
    buyFeeBps: basisPoints,
    sellFeeBps: basisPoints,
    sellTaxBps: basisPoints,
    slippageBps: basisPoints,
  })
  .strict();
export const movingAverageBacktestConfigSchema = z
  .object({ strategy: movingAverageConfigSchema, execution: backtestConfigSchema })
  .strict();

export type MovingAverageConfig = z.infer<typeof movingAverageConfigSchema>;
export type BacktestConfig = z.infer<typeof backtestConfigSchema>;
