import { desc, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { historicalDatasetSchema } from '@hth/contracts';
import type { HistoricalDataset } from '@hth/contracts';
import type * as schema from './schema.js';
import { candleRevisions, historicalDatasets, instruments } from './schema.js';
import { candleRevision, contentHash } from './content-hash.js';

export function createDatasetStore(db: NodePgDatabase<typeof schema>) {
  async function verifySchema() {
    try {
      await db.select({ id: historicalDatasets.id }).from(historicalDatasets).limit(0);
      const result = await db.execute<{ count: string }>(
        sql`SELECT count(*)::text AS count FROM pg_trigger WHERE NOT tgisinternal AND tgenabled IN ('O', 'A') AND ((tgname = 'immutable_candle_revisions' AND tgrelid = 'public.candle_revisions'::regclass) OR (tgname = 'immutable_historical_datasets' AND tgrelid = 'public.historical_datasets'::regclass))`,
      );
      if (result.rows[0]?.count !== '2') throw new Error('MISSING_IMMUTABLE_GUARDS');
    } catch {
      throw new Error('BACKFILL_SCHEMA_NOT_READY');
    }
  }
  async function get(id: string) {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id))
      throw new Error('INVALID_DATASET_ID');
    const [row] = await db.select().from(historicalDatasets).where(eq(historicalDatasets.id, id));
    if (!row) throw new Error('DATASET_NOT_FOUND');
    const parsed = historicalDatasetSchema.safeParse(row.payload);
    if (!parsed.success || contentHash(parsed.data) !== row.contentHash) throw new Error('DATASET_INTEGRITY_FAILED');
    return { id: row.id, contentHash: row.contentHash, createdAt: row.createdAt, dataset: parsed.data };
  }
  return {
    get,
    verifySchema,
    async list() {
      const rows = await db
        .select({
          id: historicalDatasets.id,
          contentHash: historicalDatasets.contentHash,
          createdAt: historicalDatasets.createdAt,
        })
        .from(historicalDatasets)
        .orderBy(desc(historicalDatasets.createdAt))
        .limit(100);
      return rows;
    },
    async freeze(input: HistoricalDataset) {
      const parsed = historicalDatasetSchema.safeParse(input);
      if (!parsed.success) throw new Error('INVALID_HISTORICAL_DATASET');
      const dataset = parsed.data;
      if (
        !dataset.coverage.complete ||
        dataset.candles.length === 0 ||
        dataset.candles.some((candle) => !candle.isClosed)
      )
        throw new Error('INCOMPLETE_DATASET');
      await verifySchema();
      const hash = contentHash(dataset);
      const id = await db.transaction(async (transaction) => {
        const [instrument] = await transaction
          .insert(instruments)
          .values({
            market: dataset.request.instrument.market,
            symbol: dataset.request.instrument.symbol,
            currency: dataset.instrument.currency,
            name: dataset.instrument.name,
          })
          .onConflictDoUpdate({
            target: [instruments.market, instruments.symbol],
            set: { name: dataset.instrument.name },
          })
          .returning({ id: instruments.id });
        if (!instrument) throw new Error('INSTRUMENT_SAVE_FAILED');
        for (const observation of dataset.observations) {
          const revision = candleRevision(observation.candle);
          await transaction
            .insert(candleRevisions)
            .values({
              instrumentId: instrument.id,
              interval: observation.candle.interval,
              timestamp: observation.candle.timestamp,
              adjusted: observation.candle.adjusted,
              source: observation.candle.source,
              ...revision,
            })
            .onConflictDoNothing();
        }
        const [created] = await transaction
          .insert(historicalDatasets)
          .values({ contentHash: hash, payload: dataset })
          .onConflictDoNothing({ target: historicalDatasets.contentHash })
          .returning({ id: historicalDatasets.id });
        if (created) return created.id;
        const [existing] = await transaction
          .select({ id: historicalDatasets.id })
          .from(historicalDatasets)
          .where(eq(historicalDatasets.contentHash, hash));
        if (!existing) throw new Error('DATASET_SAVE_FAILED');
        return existing.id;
      });
      return get(id);
    },
  };
}
