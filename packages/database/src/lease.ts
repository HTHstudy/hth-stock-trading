import type pg from 'pg';

export async function withBrokerLease<Result>(
  pool: pg.Pool,
  key: number,
  operation: (signal: AbortSignal) => Promise<Result>,
) {
  const client = await pool.connect();
  const controller = new AbortController();
  const lostConnection = () => {
    controller.abort();
  };
  client.on('error', lostConnection);
  client.on('end', lostConnection);
  let acquired = false;
  try {
    const result = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock($1::int, $2::int) AS acquired',
      [4_739_144, key],
    );
    acquired = result.rows[0]?.acquired === true;
    if (!acquired) throw new Error('BROKER_LEASE_BUSY');
    const value = await operation(controller.signal);
    if (controller.signal.aborted) throw new Error('BROKER_LEASE_LOST');
    return value;
  } finally {
    try {
      if (acquired && !controller.signal.aborted)
        await client.query('SELECT pg_advisory_unlock($1::int, $2::int)', [4_739_144, key]);
    } finally {
      client.removeListener('error', lostConnection);
      client.removeListener('end', lostConnection);
      client.release(true);
    }
  }
}
