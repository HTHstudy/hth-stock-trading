import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export function createDatabase(connectionString: string) {
  const pool = new pg.Pool({ connectionString, max: 5 });
  return { db: drizzle(pool, { schema }), close: () => pool.end() };
}

export { candles, instruments } from './schema.js';
