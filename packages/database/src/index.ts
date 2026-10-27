import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';
import { createMarketDataStore } from './market-data.js';
import { withBrokerLease } from './lease.js';

export function createDatabase(connectionString: string) {
  const pool = new pg.Pool({ connectionString, max: 5, connectionTimeoutMillis: 5000, query_timeout: 10_000 });
  const db = drizzle(pool, { schema });
  return {
    db,
    marketData: createMarketDataStore(db),
    withBrokerLease: <Result>(key: number, operation: (signal: AbortSignal) => Promise<Result>) =>
      withBrokerLease(pool, key, operation),
    close: () => pool.end(),
  };
}

export { candles, instruments } from './schema.js';
