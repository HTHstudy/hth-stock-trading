import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';
import { createMarketDataStore } from './market-data.js';
import { withBrokerLease } from './lease.js';
import { createDatasetStore } from './datasets.js';
import { createPaperLedger } from './paper-ledger.js';

export function createDatabase(connectionString: string) {
  const pool = new pg.Pool({ connectionString, max: 5, connectionTimeoutMillis: 5000, query_timeout: 10_000 });
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
