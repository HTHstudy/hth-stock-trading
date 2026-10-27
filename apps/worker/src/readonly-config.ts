import { paperModeSchema } from '@hth/shared';
import { z } from 'zod';

const symbols = z
  .string()
  .default('KR:005930,US:AAPL')
  .transform((value) => value.split(',').map((entry) => entry.trim()))
  .pipe(
    z
      .array(z.string().regex(/^(KR|US):[A-Za-z0-9.-]{1,40}$/))
      .min(1)
      .max(20),
  )
  .transform((entries) =>
    entries.map((entry) => {
      const [market, symbol] = entry.split(':');
      return { market: market as 'KR' | 'US', symbol: symbol!.toUpperCase() };
    }),
  )
  .refine((entries) => new Set(entries.map((entry) => entry.symbol)).size === entries.length);

const configSchema = z.object({
  TRADING_MODE: paperModeSchema,
  TOSS_CLIENT_ID: z.string().trim().min(1),
  TOSS_CLIENT_SECRET: z.string().trim().min(1),
  DATABASE_URL: z.url().refine((value) => ['postgres:', 'postgresql:'].includes(new URL(value).protocol)),
  READONLY_SYMBOLS: symbols,
  CANDLE_INTERVAL: z.enum(['1m', '1d']).default('1m'),
  CANDLE_MAX_PAGES: z.coerce.number().int().min(1).max(5).default(1),
});

export function parseReadonlyConfig(environment: Record<string, string | undefined>) {
  const parsed = configSchema.safeParse(environment);
  if (!parsed.success) throw new Error('READONLY_CONFIGURATION_INVALID');
  return parsed.data;
}
