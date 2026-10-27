import type { Candle } from '@hth/shared';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from './schema.js';
import { candles, instruments } from './schema.js';

export interface MarketDataBatch {
  readonly instrument: {
    readonly id: Candle['instrument'];
    readonly currency: Candle['currency'];
    readonly name: string;
  };
  readonly candles: readonly Candle[];
}

export function validateMarketData(batches: readonly MarketDataBatch[]) {
  for (const batch of batches) {
    for (const candle of batch.candles) {
      if (
        candle.instrument.market !== batch.instrument.id.market ||
        candle.instrument.symbol !== batch.instrument.id.symbol ||
        candle.currency !== batch.instrument.currency
      )
        throw new Error('CANDLE_INSTRUMENT_MISMATCH');
      for (const amount of [candle.open, candle.high, candle.low, candle.close, candle.volume]) {
        if (!/^\d+(\.\d+)?$/.test(amount)) throw new Error('INVALID_CANDLE_DECIMAL');
        const [whole = '', fraction = ''] = amount.split('.');
        if (whole.replace(/^0+/, '').length > 20 || fraction.replace(/0+$/, '').length > 10)
          throw new Error('CANDLE_PRECISION_EXCEEDED');
      }
    }
  }
}

export function createMarketDataStore(db: NodePgDatabase<typeof schema>) {
  return {
    async save(batches: readonly MarketDataBatch[]) {
      validateMarketData(batches);
      return db.transaction(async (transaction) => {
        let saved = 0;
        for (const batch of batches) {
          const [instrument] = await transaction
            .insert(instruments)
            .values({
              market: batch.instrument.id.market,
              symbol: batch.instrument.id.symbol,
              currency: batch.instrument.currency,
              name: batch.instrument.name,
            })
            .onConflictDoUpdate({
              target: [instruments.market, instruments.symbol],
              set: { name: batch.instrument.name },
            })
            .returning({ id: instruments.id });
          if (!instrument) throw new Error('INSTRUMENT_SAVE_FAILED');
          for (const candle of batch.candles) {
            const values = {
              instrumentId: instrument.id,
              interval: candle.interval,
              timestamp: candle.timestamp,
              tradingDate: candle.tradingDate,
              open: candle.open,
              high: candle.high,
              low: candle.low,
              close: candle.close,
              volume: candle.volume,
              adjusted: candle.adjusted,
              source: candle.source,
              isClosed: candle.isClosed,
            };
            await transaction
              .insert(candles)
              .values(values)
              .onConflictDoUpdate({
                target: [candles.instrumentId, candles.interval, candles.timestamp, candles.adjusted, candles.source],
                set: {
                  open: candle.open,
                  high: candle.high,
                  low: candle.low,
                  close: candle.close,
                  volume: candle.volume,
                  tradingDate: candle.tradingDate,
                  isClosed: candle.isClosed,
                  collectedAt: new Date(),
                },
              });
            saved += 1;
          }
        }
        return saved;
      });
    },
  };
}
