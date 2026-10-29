import { z } from 'zod';

export const watchlistInstrumentSchema = z
  .object({
    market: z.enum(['KR', 'US']),
    symbol: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9.-]{1,40}$/),
  })
  .strict();
export const watchlistInstrumentsSchema = z
  .array(watchlistInstrumentSchema)
  .max(20)
  .refine((items) => new Set(items.map((item) => item.symbol)).size === items.length, { message: 'Duplicate symbol' });
const revision = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER - 1);
export const watchlistStateSchema = z
  .object({ revision, origin: z.enum(['environment', 'saved']), instruments: watchlistInstrumentsSchema })
  .strict();
export const watchlistUpdateSchema = z
  .object({ expectedRevision: revision, instruments: watchlistInstrumentsSchema })
  .strict();
export type WatchlistState = z.infer<typeof watchlistStateSchema>;
