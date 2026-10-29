import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { z } from 'zod';
import { paperModeSchema } from '@hth/contracts';
import { parseReadonlyConfig, parseReadonlySymbols } from './readonly-config.js';

export function parseMarketObservationConfig(args: string[], environment: Record<string, string | undefined>) {
  try {
    paperModeSchema.parse(environment.TRADING_MODE);
    const { values } = parseArgs({
      args,
      options: {
        demo: { type: 'boolean', default: false },
        samples: { type: 'string' },
        'interval-seconds': { type: 'string' },
        symbols: { type: 'string' },
        output: { type: 'string' },
        'regular-only': { type: 'boolean', default: false },
        'start-at': { type: 'string' },
      },
    });
    const instruments = parseReadonlySymbols(
      values.symbols ?? (values.demo ? 'KR:005930' : environment.READONLY_SYMBOLS),
    );
    if (instruments.length > 5 || (values.demo && instruments.some((instrument) => instrument.market !== 'KR')))
      throw new Error('INVALID_SYMBOLS');
    const broker = values.demo
      ? null
      : parseReadonlyConfig({ ...environment, READONLY_SYMBOLS: values.symbols ?? environment.READONLY_SYMBOLS });
    if (broker && (broker.CANDLE_INTERVAL !== '1m' || broker.CANDLE_MAX_PAGES !== 1))
      throw new Error('INVALID_CANDLE_SETTINGS');
    if (
      (values['start-at'] && !values['regular-only']) ||
      (values['regular-only'] && (!broker || new Set(instruments.map((item) => item.market)).size !== 1))
    )
      throw new Error('INVALID_SESSION_SETTINGS');
    return {
      startAt: values['start-at'] === undefined ? null : z.iso.datetime({ offset: true }).parse(values['start-at']),
      regularMarket: values['regular-only'] ? instruments[0]!.market : null,
      source: values.demo ? ('synthetic-only' as const) : ('toss-readonly' as const),
      instruments,
      samples: z.coerce
        .number()
        .int()
        .min(1)
        .max(10000)
        .parse(values.samples ?? '1'),
      intervalMs:
        z.coerce
          .number()
          .int()
          .min(10)
          .max(3600)
          .parse(values['interval-seconds'] ?? '60') * 1000,
      timeoutMs: 10000,
      outputDirectory: resolve(
        fileURLToPath(new URL('../../../', import.meta.url)),
        z
          .string()
          .trim()
          .min(1)
          .parse(values.output ?? '.local-data/observations'),
      ),
      broker,
    };
  } catch {
    throw new Error('MARKET_OBSERVATION_CONFIGURATION_INVALID');
  }
}
