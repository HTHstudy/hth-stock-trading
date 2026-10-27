import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { expect, it } from 'vitest';
import type { Candle } from '@hth/shared';
import { createDatabase } from './index.js';
import { candles, instruments } from './schema.js';

it.skipIf(!process.env.TEST_DATABASE_URL)(
  '전용 PostgreSQL에서 upsert·트랜잭션 rollback·프로세스 간 lease를 검증한다',
  async () => {
    const connectionString = process.env.TEST_DATABASE_URL!;
    const target = new URL(connectionString);
    if (
      !['localhost', '127.0.0.1'].includes(target.hostname) ||
      target.pathname !== '/hth_readonly_test' ||
      target.username !== 'hth_test'
    )
      throw new Error('UNSAFE_TEST_DATABASE');
    const database = createDatabase(connectionString);
    const contender = createDatabase(connectionString);
    const candle: Candle = {
      instrument: { market: 'US', symbol: 'AAPL' },
      interval: '1m',
      timestamp: '2026-03-25T13:31:00Z',
      tradingDate: '2026-03-25',
      open: '185.7',
      high: '186',
      low: '185',
      close: '185.71',
      volume: '10',
      currency: 'USD',
      adjusted: false,
      source: 'toss',
      isClosed: false,
    };
    const instrument = { id: candle.instrument, currency: candle.currency, name: 'Apple' };
    try {
      await migrate(database.db, { migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)) });
      await database.db.delete(candles);
      await database.db.delete(instruments);
      expect(await database.marketData.save([{ instrument, candles: [candle] }])).toBe(1);
      expect(await database.marketData.save([{ instrument, candles: [{ ...candle, close: '185.75' }] }])).toBe(1);
      expect(await database.db.select().from(candles)).toMatchObject([{ close: '185.7500000000', isClosed: false }]);
      await expect(
        database.withBrokerLease(987654, async () => {
          await expect(contender.withBrokerLease(987654, async () => {})).rejects.toThrow('BROKER_LEASE_BUSY');
        }),
      ).resolves.toBeUndefined();
      await expect(contender.withBrokerLease(987654, async () => 'released')).resolves.toBe('released');
      await expect(
        database.marketData.save([
          { instrument: { id: { market: 'KR', symbol: '005930' }, currency: 'KRW', name: 'Samsung' }, candles: [] },
          {
            instrument: { id: { market: 'KR', symbol: 'invalid-currency' }, currency: 'USD', name: 'Invalid' },
            candles: [],
          },
        ]),
      ).rejects.toThrow();
      expect(await database.db.select().from(instruments)).toHaveLength(1);
    } finally {
      await database.close();
      await contender.close();
    }
  },
  30_000,
);
