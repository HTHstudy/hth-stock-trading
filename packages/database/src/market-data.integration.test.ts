import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { migrateTestDatabase, testDatabaseUrl } from '../test/setup.js';
import { expect, it } from 'vitest';
import type { Candle, HistoricalDataset } from '@hth/contracts';
import { createDatabase } from './index.js';
import { candles, instruments, candleRevisions, historicalDatasets } from './schema.js';

it.skipIf(!process.env.TEST_DATABASE_URL)(
  '전용 PostgreSQL에서 upsert·트랜잭션 rollback·프로세스 간 lease를 검증한다',
  async () => {
    const connectionString = testDatabaseUrl();
    const database = createDatabase(connectionString);
    const contender = createDatabase(connectionString);
    const candle: Candle = {
      instrument: { market: 'US', symbol: `TEST-${randomUUID().slice(0, 8).toUpperCase()}` },
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
      await migrateTestDatabase(database);
      expect(await database.marketData.save([{ instrument, candles: [candle] }])).toBe(1);
      expect(await database.marketData.save([{ instrument, candles: [{ ...candle, close: '185.75' }] }])).toBe(1);
      const [savedInstrument] = await database.db
        .select()
        .from(instruments)
        .where(eq(instruments.symbol, candle.instrument.symbol));
      expect(savedInstrument).toBeDefined();
      const instrumentId = savedInstrument!.id;
      expect(await database.db.select().from(candles).where(eq(candles.instrumentId, instrumentId))).toMatchObject([
        { close: '185.7500000000', isClosed: false },
      ]);
      expect(
        await database.db.select().from(candleRevisions).where(eq(candleRevisions.instrumentId, instrumentId)),
      ).toHaveLength(2);
      await expect(
        database.withBrokerLease(987654, async () => {
          await expect(contender.withBrokerLease(987654, async () => {})).rejects.toThrow('BROKER_LEASE_BUSY');
        }),
      ).resolves.toBeUndefined();
      await expect(contender.withBrokerLease(987654, async () => 'released')).resolves.toBe('released');
      const rollbackSymbol = `ROLLBACK-${randomUUID().slice(0, 8).toUpperCase()}`;
      await expect(
        database.marketData.save([
          {
            instrument: { id: { market: 'KR', symbol: rollbackSymbol }, currency: 'KRW', name: 'Samsung' },
            candles: [],
          },
          {
            instrument: { id: { market: 'KR', symbol: 'invalid-currency' }, currency: 'USD', name: 'Invalid' },
            candles: [],
          },
        ]),
      ).rejects.toThrow();
      expect(await database.db.select().from(instruments).where(eq(instruments.symbol, rollbackSymbol))).toHaveLength(
        0,
      );
      const observedAt = '2026-03-26T00:00:00Z';
      const frozenCandle = { ...candle, isClosed: true };
      const dataset: HistoricalDataset = {
        formatVersion: 'historical-dataset-v1',
        policyVersion: 'market-data-v1',
        request: {
          instrument: candle.instrument,
          interval: candle.interval,
          adjusted: false,
          from: candle.tradingDate,
          to: candle.tradingDate,
          source: 'toss',
        },
        startedAt: observedAt,
        completedAt: observedAt,
        pointInTime: false,
        historicalNxtPolicy: 'conservative-non-nxt',
        instrument: { name: 'Test', currency: 'USD', nxtSupportedAtCollection: null },
        calendars: [
          {
            day: {
              market: 'US',
              tradingDate: candle.tradingDate,
              sessionsKnown: true,
              sessions: [{ type: 'regular', startsAt: '2026-03-25T13:30:00Z', endsAt: '2026-03-25T13:31:00Z' }],
            },
            observedAt,
          },
        ],
        observations: [{ candle, observedAt, page: 1 }],
        assessments: [
          { timestamp: candle.timestamp, status: 'closed', reason: null, usableAt: '2026-03-25T13:32:00Z' },
        ],
        candles: [frozenCandle],
        coverage: {
          complete: true,
          excludedBars: 0,
          pendingBars: 0,
          invalidBars: 0,
          days: [{ date: candle.tradingDate, expectedBars: 1, observedBars: 1, missingBars: 0, status: 'complete' }],
        },
        warnings: ['RETROSPECTIVE_DATA'],
      };
      const original = await database.datasets.freeze(dataset);
      expect((await database.datasets.freeze(dataset)).id).toBe(original.id);
      const changed: HistoricalDataset = {
        ...dataset,
        observations: [{ candle: { ...candle, close: '185.9' }, observedAt, page: 1 }],
        candles: [{ ...frozenCandle, close: '185.9' }],
      };
      const revised = await database.datasets.freeze(changed);
      expect(revised.contentHash).not.toBe(original.contentHash);
      expect((await database.datasets.get(original.id)).dataset.candles[0]?.close).toBe('185.71');
      const [corrupted] = await database.db
        .insert(historicalDatasets)
        .values({ contentHash: randomUUID().replaceAll('-', '').repeat(2), payload: dataset })
        .returning({ id: historicalDatasets.id });
      await expect(database.datasets.get(corrupted!.id)).rejects.toThrow('DATASET_INTEGRITY_FAILED');
      expect(
        await database.db.select().from(candleRevisions).where(eq(candleRevisions.instrumentId, instrumentId)),
      ).toHaveLength(3);
      await expect(
        database.datasets.freeze({ ...dataset, coverage: { ...dataset.coverage, complete: false } }),
      ).rejects.toThrow('INCOMPLETE_DATASET');
      for (const table of [candleRevisions, historicalDatasets]) {
        for (const statement of [sql`DELETE FROM ${table}`, sql`TRUNCATE ${table}`]) {
          await expect(database.db.execute(statement)).rejects.toMatchObject({ cause: { code: '55000' } });
        }
      }
      await expect(
        database.db
          .update(historicalDatasets)
          .set({ contentHash: original.contentHash })
          .where(eq(historicalDatasets.id, original.id)),
      ).rejects.toMatchObject({ cause: { code: '55000' } });
      await expect(
        database.db
          .update(candleRevisions)
          .set({ source: 'changed' })
          .where(eq(candleRevisions.instrumentId, instrumentId)),
      ).rejects.toMatchObject({ cause: { code: '55000' } });
    } finally {
      await database.close();
      await contender.close();
    }
  },
  30_000,
);
