import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { paperRiskLimitsSchema, paperStrategyDefinitionSchema } from '@hth/contracts';
import type { InstrumentId } from '@hth/contracts';
import { contentHash } from '@hth/database';
import { movingAverageCross } from '@hth/trading';

const krw = z.string().regex(/^\d{1,18}$/);
const usd = z.string().regex(/^\d{1,18}(\.\d{1,2})?$/);
export const paperMarketPlanSchema = z
  .object({
    formatVersion: z.literal('paper-market-plan-v1'),
    mode: z.literal('paper'),
    source: z.literal('toss-readonly'),
    purpose: z.literal('validation-only'),
    executionEnabled: z.literal(false),
    strategyVersion: z.literal(movingAverageCross.version),
    cash: z.object({ KRW: krw, USD: usd }).strict(),
    limits: paperRiskLimitsSchema,
    strategy: paperStrategyDefinitionSchema,
  })
  .strict()
  .refine((plan) => {
    const currency = plan.strategy.instrument.market === 'KR' ? 'KRW' : 'USD';
    return (
      plan.strategy.parameters.slowPeriod < 200 &&
      /[1-9]/.test(plan.cash[currency]) &&
      [plan.limits.KRW.maxOrderAmount, plan.limits.KRW.maxInstrumentAmount, plan.limits.KRW.maxDailyLoss].every(
        (value) => krw.safeParse(value).success,
      ) &&
      [plan.limits.USD.maxOrderAmount, plan.limits.USD.maxInstrumentAmount, plan.limits.USD.maxDailyLoss].every(
        (value) => usd.safeParse(value).success,
      )
    );
  });
export type PaperMarketPlan = z.infer<typeof paperMarketPlanSchema>;

export function defaultPaperMarketPlan(instrument: InstrumentId): PaperMarketPlan {
  return paperMarketPlanSchema.parse({
    formatVersion: 'paper-market-plan-v1',
    mode: 'paper',
    source: 'toss-readonly',
    purpose: 'validation-only',
    executionEnabled: false,
    strategyVersion: movingAverageCross.version,
    cash: { KRW: '1000000', USD: '1000' },
    limits: {
      KRW: {
        maxOrderAmount: '100000',
        maxInstrumentAmount: '200000',
        maxDailyLoss: '10000',
        buyCostBps: '10',
        sellCostBps: '30',
      },
      USD: {
        maxOrderAmount: '100',
        maxInstrumentAmount: '200',
        maxDailyLoss: '10',
        buyCostBps: '10',
        sellCostBps: '30',
      },
      maxPositions: 5,
    },
    strategy: {
      kind: 'moving-average-cross',
      instrument,
      parameters: { fastPeriod: 5, slowPeriod: 20 },
      quantity: '1',
      maxFillQuantity: '1',
    },
  });
}

export function verifyPaperMarketPlan(input: unknown, expectedHash: string): PaperMarketPlan {
  const plan = paperMarketPlanSchema.parse(input);
  if (contentHash(plan) !== expectedHash) throw new Error('PAPER_MARKET_PLAN_HASH_MISMATCH');
  return plan;
}

export async function readPaperMarketPlan(path: string): Promise<PaperMarketPlan> {
  try {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const file = await open(resolve(root, path), constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > 65536) throw new Error('INVALID_FILE');
      const buffer = Buffer.alloc(65537);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > 65536) throw new Error('INVALID_FILE');
      return paperMarketPlanSchema.parse(JSON.parse(buffer.subarray(0, length).toString('utf8')));
    } finally {
      await file.close();
    }
  } catch {
    throw new Error('PAPER_MARKET_PLAN_INVALID');
  }
}
