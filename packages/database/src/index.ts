import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';
import { createMarketDataStore } from './market-data.js';
import { withBrokerLease } from './lease.js';
import { createDatasetStore } from './datasets.js';
import { createPaperLedger } from './paper-ledger.js';

export function createDatabase(connectionString: string) {
  const pool = new pg.Pool({ connectionString, max: 5, connectionTimeoutMillis: 5000, query_timeout: 10_000 });
  pool.on('error', () => {
    // pg removes the failed idle client itself. Never emit its Error/client
    // object: they can contain connection credentials. Queries still reject,
    // and borrowed broker leases retain their own connection-loss fencing.
    console.error(JSON.stringify({ service: 'database', code: 'DATABASE_IDLE_CONNECTION_LOST' }));
  });
  const db = drizzle(pool, { schema });
  return {
    db,
    marketData: createMarketDataStore(db),
    datasets: createDatasetStore(db),
    paper: createPaperLedger(db),
    withBrokerLease: <Result>(key: number, operation: (signal: AbortSignal) => Promise<Result>) =>
      withBrokerLease(pool, key, operation),
    close: () => pool.end(),
  };
}

export { candles, instruments, candleRevisions, historicalDatasets } from './schema.js';
export { paperAccounts, paperStrategies, paperIntents, paperReservations, paperEvents } from './schema.js';
export { paperFills, paperCostBasis } from './schema.js';
export { paperStrategyRevisions } from './schema.js';
export { canonicalJson, contentHash, candleRevision } from './content-hash.js';
