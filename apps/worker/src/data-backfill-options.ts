import { parseArgs } from 'node:util';
import { z } from 'zod';
import { validateHistoricalOutput } from './historical-export.js';

export function parseBackfillOptions(args: string[]) {
  try {
    const { values } = parseArgs({
      args,
      options: {
        market: { type: 'string' },
        symbol: { type: 'string' },
        from: { type: 'string' },
        to: { type: 'string' },
        interval: { type: 'string' },
        'max-pages': { type: 'string' },
        adjusted: { type: 'boolean', default: false },
        save: { type: 'boolean', default: false },
        output: { type: 'string' },
      },
    });
    const options = z
      .object({
        market: z.enum(['KR', 'US']),
        symbol: z
          .string()
          .regex(/^[A-Za-z0-9.-]{1,40}$/)
          .transform((value) => value.toUpperCase()),
        from: z.iso.date(),
        to: z.iso.date(),
        interval: z.enum(['1m', '1d']).default('1d'),
        'max-pages': z.coerce.number().int().min(1).max(100).default(50),
        adjusted: z.boolean(),
        save: z.boolean(),
        output: z.string().optional(),
      })
      .parse(values);
    if (options.save && options.output !== undefined) throw new Error('INVALID_HISTORICAL_REQUEST');
    if (options.output !== undefined) validateHistoricalOutput(options.output);
    return options;
  } catch {
    throw new Error('INVALID_HISTORICAL_REQUEST');
  }
}
