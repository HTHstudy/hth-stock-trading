import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { createDatabase } from './index.js';

export function testDatabaseUrl(value = process.env.TEST_DATABASE_URL) {
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
export async function migrateTestDatabase(database: ReturnType<typeof createDatabase>, value = testDatabaseUrl()) {
  const url = testDatabaseUrl(value);
  const actual = testDatabaseUrl(database.db.$client.options.connectionString ?? '');
  if (new URL(actual).href !== new URL(url).href) throw new Error('UNSAFE_TEST_DATABASE');
  const target = await database.db.execute<{ name: string; role: string }>(
    sql`SELECT current_database() AS name, current_user AS role`,
  );
  if (target.rows[0]?.name !== 'hth_readonly_test' || target.rows[0]?.role !== 'hth_test')
    throw new Error('UNSAFE_TEST_DATABASE');
  const connection = new pg.Client({
    connectionString: url,
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
