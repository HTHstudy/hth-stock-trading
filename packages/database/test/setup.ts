import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { createDatabase } from '../src/index.js';

export function testDatabaseUrl() {
  const value = process.env.TEST_DATABASE_URL;
  if (!value) throw new Error('TEST_DATABASE_URL_REQUIRED');
  const target = new URL(value);
  if (
    !['localhost', '127.0.0.1'].includes(target.hostname) ||
    target.pathname !== '/hth_readonly_test' ||
    target.username !== 'hth_test'
  )
    throw new Error('UNSAFE_TEST_DATABASE');
  return value;
}
export async function migrateTestDatabase(database: ReturnType<typeof createDatabase>) {
  const connection = new pg.Client({
    connectionString: testDatabaseUrl(),
    connectionTimeoutMillis: 5000,
    query_timeout: 20_000,
  });
  await connection.connect();
  try {
    await connection.query('SELECT pg_advisory_lock(176829341)');
    try {
      await migrate(database.db, { migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)) });
    } finally {
      await connection.query('SELECT pg_advisory_unlock(176829341)');
    }
  } finally {
    await connection.end();
  }
}
