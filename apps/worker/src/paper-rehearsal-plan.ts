import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { z } from 'zod';
import { paperModeSchema, paperRiskLimitsSchema, watchlistInstrumentSchema } from '@hth/contracts';
import { testDatabaseUrl } from '@hth/database/testing';
const amount = z
  .string()
  .regex(/^\d+(\.\d+)?$/)
  .max(30);
const positive = amount.refine((value) => /[1-9]/.test(value));
const prices = z.tuple([positive, positive, positive]);
export const paperRehearsalPlanSchema = z
  .object({
    formatVersion: z.literal('paper-rehearsal-v1'),
    source: z.literal('synthetic-only'),
    executionEnabled: z.literal(false),
    cash: z.object({ KRW: amount, USD: amount }).strict(),
    strategy: z
      .object({
        fastPeriod: z.literal(1),
        slowPeriod: z.literal(2),
        quantity: z.literal('2'),
        maxFillQuantity: z.literal('1'),
      })
      .strict(),
    manualQuantity: z.literal('3'),
    limits: paperRiskLimitsSchema,
    profiles: z
      .array(
        z
          .object({
            instrument: watchlistInstrumentSchema,
            manualInstrument: watchlistInstrumentSchema,
            flat: prices,
            bullish: prices,
            bearish: prices,
            expectedRoundTrip: z
              .object({
                cash: amount,
                equity: amount,
                dailyPnl: z
                  .string()
                  .regex(/^-?\d+(\.\d+)?$/)
                  .max(30),
              })
              .strict(),
          })
          .strict(),
      )
      .min(1)
      .max(2),
  })
  .strict()
  .refine(
    (plan) =>
      new Set(plan.profiles.map((profile) => profile.instrument.market)).size === plan.profiles.length &&
      plan.profiles.every(
        (p) => p.instrument.market === p.manualInstrument.market && p.instrument.symbol !== p.manualInstrument.symbol,
      ),
  );
export type PaperRehearsalPlan = z.infer<typeof paperRehearsalPlanSchema>;
export function rehearsalDatabaseUrl(value: string | undefined) {
  const url = testDatabaseUrl(value ?? '');
  const parsed = new URL(url);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || parsed.search || parsed.hash)
    throw new Error('UNSAFE_TEST_DATABASE');
  return url;
}
export function parsePaperRehearsalConfig(args: string[], environment: Record<string, string | undefined>) {
  try {
    paperModeSchema.parse(environment.TRADING_MODE);
    const { values } = parseArgs({
      args,
      options: {
        execute: { type: 'boolean', default: false },
        prepare: { type: 'boolean', default: false },
        plan: { type: 'string' },
        output: { type: 'string' },
      },
    });
    if (values.prepare && !values.execute) throw new Error('INVALID_FLAGS');
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    return {
      execute: values.execute,
      prepare: values.prepare,
      databaseUrl: values.execute ? rehearsalDatabaseUrl(environment.PAPER_REHEARSAL_DATABASE_URL) : null,
      planPath: resolve(root, values.plan ?? 'examples/paper-rehearsal-plan.json'),
      output: resolve(root, values.output ?? '.local-data/rehearsals'),
    };
  } catch {
    throw new Error('PAPER_REHEARSAL_CONFIGURATION_INVALID');
  }
}
