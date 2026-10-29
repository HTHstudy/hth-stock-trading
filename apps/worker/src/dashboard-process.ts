import { createHash } from 'node:crypto';
import { dashboardErrorSchema, watchlistInstrumentsSchema } from '@hth/contracts';
import { BrokerError } from '@hth/broker';
import { createTossReadonlyBroker } from '@hth/broker/toss';
import { createDatabase } from '@hth/database';
import { parseReadonlyConnectionConfig, parseReadonlySymbols } from './readonly-config.js';
import { collectReadonlySnapshot } from './readonly-snapshot.js';
import { createDashboardSnapshot } from './dashboard-model.js';

async function main() {
  if (!process.send) throw new Error('WORKER_ERROR');
  const config = parseReadonlyConnectionConfig(process.env);
  const instruments =
    process.env.DASHBOARD_WATCHLIST_JSON === undefined
      ? parseReadonlySymbols(process.env.READONLY_SYMBOLS)
      : watchlistInstrumentsSchema.parse(JSON.parse(process.env.DASHBOARD_WATCHLIST_JSON));
  const database = createDatabase(config.DATABASE_URL);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('disconnect', cancel);
  process.once('SIGTERM', cancel);
  try {
    const key = createHash('sha256').update(config.TOSS_CLIENT_ID).digest().readInt32BE(0);
    const snapshot = await database.withBrokerLease(key, async (leaseSignal) => {
      const signal = AbortSignal.any([leaseSignal, controller.signal]);
      const broker = createTossReadonlyBroker({
        clientId: config.TOSS_CLIENT_ID,
        clientSecret: config.TOSS_CLIENT_SECRET,
        signal,
      });
      const source = await collectReadonlySnapshot(broker, instruments, config.CANDLE_INTERVAL, 1);
      signal.throwIfAborted();
      return createDashboardSnapshot(source, new Date().toISOString());
    });
    await new Promise<void>((resolve, reject) =>
      process.send!({ type: 'snapshot', snapshot }, (error: Error | null) => (error ? reject(error) : resolve())),
    );
  } finally {
    await database.close();
    process.removeListener('disconnect', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}

main().catch((error: unknown) => {
  const parsed = dashboardErrorSchema.safeParse(
    error instanceof BrokerError ? error.code : error instanceof Error ? error.message : 'WORKER_ERROR',
  );
  process.send?.({ type: 'error', code: parsed.success ? parsed.data : 'WORKER_ERROR' });
  process.exitCode = 1;
});
