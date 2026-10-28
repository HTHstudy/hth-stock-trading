import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  numeric,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { HistoricalDataset } from '@hth/contracts';

export const marketEnum = pgEnum('market', ['KR', 'US']);
export const currencyEnum = pgEnum('currency', ['KRW', 'USD']);
export const intervalEnum = pgEnum('candle_interval', ['1m', '1d']);

export const instruments = pgTable(
  'instruments',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    market: marketEnum('market').notNull(),
    symbol: text('symbol').notNull(),
    currency: currencyEnum('currency').notNull(),
    name: text('name').notNull(),
  },
  (table) => [
    uniqueIndex('instruments_market_symbol_idx').on(table.market, table.symbol),
    check(
      'instruments_currency_check',
      sql`(${table.market} = 'KR' AND ${table.currency} = 'KRW') OR (${table.market} = 'US' AND ${table.currency} = 'USD')`,
    ),
  ],
);

export const candles = pgTable(
  'candles',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    instrumentId: uuid('instrument_id')
      .notNull()
      .references(() => instruments.id),
    interval: intervalEnum('interval').notNull(),
    timestamp: timestamp('timestamp', { withTimezone: true, mode: 'string' }).notNull(),
    tradingDate: date('trading_date', { mode: 'string' }).notNull(),
    open: numeric('open', { precision: 30, scale: 10 }).notNull(),
    high: numeric('high', { precision: 30, scale: 10 }).notNull(),
    low: numeric('low', { precision: 30, scale: 10 }).notNull(),
    close: numeric('close', { precision: 30, scale: 10 }).notNull(),
    volume: numeric('volume', { precision: 30, scale: 10 }).notNull(),
    adjusted: boolean('adjusted').notNull(),
    source: text('source').notNull(),
    isClosed: boolean('is_closed').notNull().default(false),
    collectedAt: timestamp('collected_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('candles_identity_idx').on(
      table.instrumentId,
      table.interval,
      table.timestamp,
      table.adjusted,
      table.source,
    ),
    check(
      'candles_ohlcv_check',
      sql`${table.low} >= 0 AND ${table.high} >= ${table.low} AND ${table.open} BETWEEN ${table.low} AND ${table.high} AND ${table.close} BETWEEN ${table.low} AND ${table.high} AND ${table.volume} >= 0`,
    ),
  ],
);

export const candleRevisions = pgTable(
  'candle_revisions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    instrumentId: uuid('instrument_id')
      .notNull()
      .references(() => instruments.id),
    interval: intervalEnum('interval').notNull(),
    timestamp: timestamp('timestamp', { withTimezone: true, mode: 'string' }).notNull(),
    adjusted: boolean('adjusted').notNull(),
    source: text('source').notNull(),
    valueHash: text('value_hash').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('candle_revisions_identity_idx').on(
      table.instrumentId,
      table.interval,
      table.timestamp,
      table.adjusted,
      table.source,
      table.valueHash,
    ),
    check('candle_revisions_hash_check', sql`${table.valueHash} ~ '^[a-f0-9]{64}$'`),
  ],
);

export const historicalDatasets = pgTable(
  'historical_datasets',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    contentHash: text('content_hash').notNull().unique(),
    payload: jsonb('payload').$type<HistoricalDataset>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [check('historical_datasets_hash_check', sql`${table.contentHash} ~ '^[a-f0-9]{64}$'`)],
);
