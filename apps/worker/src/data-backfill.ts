import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { BrokerError } from '@hth/broker';
import { createTossReadonlyBroker } from '@hth/broker/toss';
import { createDatabase } from '@hth/database';
import { parseReadonlyConfig } from './readonly-config.js';
import { collectHistoricalDataset } from './historical-collect.js';

async function main() {
  const { values } = parseArgs({
    options: {
      market: { type: 'string' },
      symbol: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      interval: { type: 'string' },
      'max-pages': { type: 'string' },
      adjusted: { type: 'boolean', default: false },
      save: { type: 'boolean', default: false },
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
    })
    .safeParse(values);
  if (!options.success) throw new Error('INVALID_HISTORICAL_REQUEST');
  const config = parseReadonlyConfig(process.env);
  const database = createDatabase(config.DATABASE_URL);
  const shutdown = new AbortController();
  const cancel = () => shutdown.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    if (options.data.save) await database.datasets.verifySchema();
    const key = createHash('sha256').update(config.TOSS_CLIENT_ID).digest().readInt32BE(0);
    const result = await database.withBrokerLease(key, async (leaseSignal) => {
      const signal = AbortSignal.any([leaseSignal, shutdown.signal, AbortSignal.timeout(600_000)]);
      const broker = createTossReadonlyBroker({
        clientId: config.TOSS_CLIENT_ID,
        clientSecret: config.TOSS_CLIENT_SECRET,
        signal,
      });
      const dataset = await collectHistoricalDataset(
        broker,
        {
          instrument: { market: options.data.market, symbol: options.data.symbol },
          from: options.data.from,
          to: options.data.to,
          interval: options.data.interval,
          adjusted: options.data.adjusted,
          source: 'toss',
        },
        { maxPages: options.data['max-pages'], signal },
      );
      signal.throwIfAborted();
      const frozen = options.data.save ? await database.datasets.freeze(dataset) : null;
      return {
        mode: 'paper',
        executionEnabled: false,
        saved: Boolean(frozen),
        id: frozen?.id ?? null,
        contentHash: frozen?.contentHash ?? null,
        candles: dataset.candles.length,
        observations: dataset.observations.length,
        complete: dataset.coverage.complete,
        missingBars: dataset.coverage.days.reduce((total, day) => total + day.missingBars, 0),
        unsettledDays: dataset.coverage.days.filter((day) => day.status === 'unsettled').length,
        unknownDays: dataset.coverage.days.filter((day) => day.status === 'unknown').length,
        pointInTime: false,
      };
    });
    console.info(JSON.stringify({ service: 'historical-backfill', ...result }));
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
    await database.close();
  }
}

main().catch((error: unknown) => {
  const allowed = [
    'INVALID_HISTORICAL_REQUEST',
    'FUTURE_HISTORICAL_RANGE',
    'BACKFILL_SCHEMA_NOT_READY',
    'INVALID_PAGE_LIMIT',
    'INVALID_HISTORICAL_PAGE',
    'HISTORICAL_INSTRUMENT_MISMATCH',
    'HISTORICAL_CANDLE_MISMATCH',
    'CALENDAR_DATE_MISMATCH',
    'CALENDAR_RANGE_MISMATCH',
    'CANDLE_CURSOR_NOT_ADVANCING',
    'BACKFILL_PAGE_LIMIT',
    'CANCELLED',
    'INCOMPLETE_DATASET',
    'BROKER_LEASE_BUSY',
    'READONLY_CONFIGURATION_INVALID',
  ];
  const message =
    error instanceof BrokerError
      ? error.code
      : error instanceof Error && allowed.includes(error.message)
        ? error.message
        : 'BACKFILL_FAILED';
  console.error(JSON.stringify({ service: 'historical-backfill', code: message, executionEnabled: false }));
  process.exitCode = 1;
});
