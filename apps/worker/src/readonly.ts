import { createHash } from 'node:crypto';
import { BrokerError } from '@hth/broker';
import { createTossReadonlyBroker } from '@hth/broker/toss';
import { createDatabase } from '@hth/database';
import { parseReadonlyConfig } from './readonly-config.js';
import { collectReadonlySnapshot } from './readonly-snapshot.js';

async function main() {
  const save = process.argv.includes('--save');
  if (process.argv.slice(2).some((argument) => argument !== '--save')) throw new Error('INVALID_ARGUMENT');
  const config = parseReadonlyConfig(process.env);
  const database = createDatabase(config.DATABASE_URL);
  const shutdown = new AbortController();
  const stop = () => {
    shutdown.abort();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const key = createHash('sha256').update(config.TOSS_CLIENT_ID).digest().readInt32BE(0);
    const summary = await database.withBrokerLease(key, async (leaseSignal) => {
      const signal = AbortSignal.any([leaseSignal, shutdown.signal]);
      const broker = createTossReadonlyBroker({
        clientId: config.TOSS_CLIENT_ID,
        clientSecret: config.TOSS_CLIENT_SECRET,
        signal,
      });
      const snapshot = await collectReadonlySnapshot(
        broker,
        config.READONLY_SYMBOLS,
        config.CANDLE_INTERVAL,
        config.CANDLE_MAX_PAGES,
      );
      signal.throwIfAborted();
      const saved = save ? await database.marketData.save(snapshot.batches) : 0;
      return { ...snapshot.summary, saved };
    });
    console.info(JSON.stringify({ service: 'readonly-check', ...summary }));
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await database.close();
  }
}

main().catch((error: unknown) => {
  const known = [
    'READONLY_CONFIGURATION_INVALID',
    'INVALID_ARGUMENT',
    'BROKER_LEASE_BUSY',
    'BROKER_LEASE_LOST',
    'CANDLE_CURSOR_NOT_ADVANCING',
    'CANDLE_PRECISION_EXCEEDED',
  ];
  const code =
    error instanceof BrokerError
      ? error.code
      : error instanceof Error && known.includes(error.message)
        ? error.message
        : 'READONLY_CHECK_FAILED';
  console.error(JSON.stringify({ service: 'readonly-check', code, executionEnabled: false }));
  process.exitCode = 1;
});
