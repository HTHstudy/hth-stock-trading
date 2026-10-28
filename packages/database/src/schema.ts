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
  bigint,
  primaryKey,
  foreignKey,
} from 'drizzle-orm/pg-core';
import type {
  HistoricalDataset,
  PaperLedgerState,
  PaperRiskLimits,
  PaperOrderCandidate,
  PaperSignal,
  PaperIntentState,
} from '@hth/contracts';
import type { RiskDecision } from '@hth/trading';

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

export const paperIntentState = pgEnum('paper_intent_state', ['INTENT_RECORDED', 'READY', 'RISK_REJECTED', 'ABORTED']);
export const paperAccounts = pgTable(
  'paper_accounts',
  {
    id: text('id').primaryKey(),
    mode: text('mode').notNull().default('paper'),
    version: bigint('version', { mode: 'number' }).notNull().default(0),
    stopped: boolean('stopped').notNull().default(true),
    epoch: bigint('epoch', { mode: 'number' }).notNull().default(0),
    reason: text('reason').notNull().default('INITIAL_STOP'),
    limits: jsonb('limits').$type<PaperRiskLimits>(),
    ledger: jsonb('ledger').$type<PaperLedgerState>().notNull(),
    leaseToken: uuid('lease_token'),
    leaseUntil: timestamp('lease_until', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    check('paper_account_mode', sql`${table.mode} = 'paper'`),
    check(
      'paper_account_versions',
      sql`${table.version} >= 0 AND ${table.version} < 9007199254740991 AND ${table.epoch} >= 0 AND ${table.epoch} < 9007199254740991`,
    ),
    check('paper_lease_pair', sql`(${table.leaseToken} IS NULL) = (${table.leaseUntil} IS NULL)`),
  ],
);
export const paperStrategies = pgTable(
  'paper_strategies',
  {
    accountId: text('account_id')
      .notNull()
      .references(() => paperAccounts.id),
    strategyId: text('strategy_id').notNull(),
    version: text('version').notNull(),
    enabled: boolean('enabled').notNull().default(false),
  },
  (table) => [primaryKey({ columns: [table.accountId, table.strategyId] })],
);
export const paperIntents = pgTable(
  'paper_order_intents',
  {
    accountId: text('account_id')
      .notNull()
      .references(() => paperAccounts.id),
    intentId: text('intent_id').notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    requestHash: text('request_hash').notNull(),
    candidate: jsonb('candidate').$type<PaperOrderCandidate>().notNull(),
    signal: jsonb('signal').$type<PaperSignal>().notNull(),
    recordedEpoch: bigint('recorded_epoch', { mode: 'number' }).notNull(),
    state: text('state').$type<PaperIntentState>().notNull().default('INTENT_RECORDED'),
    filledQuantity: numeric('filled_quantity').notNull().default('0'),
    filledNotional: numeric('filled_notional').notNull().default('0'),
    paidCosts: numeric('paid_costs').notNull().default('0'),
    version: bigint('version', { mode: 'number' }).notNull().default(0),
    decision: jsonb('decision').$type<RiskDecision>(),
    codes: jsonb('codes').$type<string[]>().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.accountId, table.intentId] }),
    uniqueIndex('paper_intent_dedupe').on(table.accountId, table.dedupeKey),
    check(
      'paper_intent_state_check',
      sql`${table.state} IN ('INTENT_RECORDED','READY','PARTIALLY_FILLED','FILLED','RISK_REJECTED','ABORTED')`,
    ),
    check(
      'paper_intent_filled_amounts',
      sql`${table.filledQuantity} >= 0 AND ${table.filledQuantity} = trunc(${table.filledQuantity}) AND ${table.filledQuantity} <= (${table.candidate}->>'quantity')::numeric AND ${table.filledNotional} >= 0 AND ${table.filledNotional} < 'Infinity'::numeric AND ${table.paidCosts} >= 0 AND ${table.paidCosts} < 'Infinity'::numeric`,
    ),
    check(
      'paper_intent_hashes',
      sql`${table.requestHash} ~ '^[a-f0-9]{64}$' AND ${table.dedupeKey} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'paper_intent_versions',
      sql`${table.version} >= 0 AND ${table.version} < 9007199254740991 AND ${table.recordedEpoch} >= 0`,
    ),
  ],
);
export const paperReservations = pgTable(
  'paper_reservations',
  {
    accountId: text('account_id').notNull(),
    intentId: text('intent_id').notNull(),
    quantity: numeric('quantity').notNull(),
    valuationPrice: numeric('valuation_price').notNull(),
    cashAmount: numeric('cash_amount').notNull(),
    sellQuantity: numeric('sell_quantity').notNull(),
    costBps: numeric('cost_bps').notNull(),
    active: boolean('active').notNull().default(true),
    validUntil: timestamp('valid_until', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.accountId, table.intentId] }),
    foreignKey({
      columns: [table.accountId, table.intentId],
      foreignColumns: [paperIntents.accountId, paperIntents.intentId],
    }),
    check(
      'paper_reservation_amounts',
      sql`${table.quantity} >= 0 AND (NOT ${table.active} OR ${table.quantity} > 0) AND ${table.quantity} = trunc(${table.quantity}) AND ${table.quantity} < 'Infinity'::numeric AND ${table.cashAmount} >= 0 AND ${table.cashAmount} < 'Infinity'::numeric AND ${table.sellQuantity} >= 0 AND ${table.sellQuantity} < 'Infinity'::numeric AND ${table.costBps} >= 0 AND ${table.costBps} < 10000 AND ((${table.cashAmount} > 0 AND ${table.sellQuantity} = 0) OR (${table.cashAmount} = 0 AND ${table.sellQuantity} = ${table.quantity}))`,
    ),
  ],
);
export const paperEvents = pgTable(
  'paper_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => paperAccounts.id),
    intentId: text('intent_id'),
    kind: text('kind').notNull(),
    details: jsonb('details').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.accountId, table.intentId],
      foreignColumns: [paperIntents.accountId, paperIntents.intentId],
    }),
  ],
);

export const paperFills = pgTable(
  'paper_fills',
  {
    accountId: text('account_id').notNull(),
    fillId: text('fill_id').notNull(),
    intentId: text('intent_id').notNull(),
    requestHash: text('request_hash').notNull(),
    model: text('model').notNull().default('quote-proxy-v1'),
    quantity: numeric('quantity').notNull(),
    price: numeric('price').notNull(),
    notional: numeric('notional').notNull(),
    costs: numeric('costs').notNull(),
    realizedPnl: numeric('realized_pnl').notNull(),
    quoteTimestamp: timestamp('quote_timestamp', { withTimezone: true, mode: 'string' }).notNull(),
    quoteObservedAt: timestamp('quote_observed_at', { withTimezone: true, mode: 'string' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.accountId, table.fillId] }),
    foreignKey({
      columns: [table.accountId, table.intentId],
      foreignColumns: [paperIntents.accountId, paperIntents.intentId],
    }),
    check(
      'paper_fill_amounts',
      sql`${table.quantity} > 0 AND ${table.quantity} = trunc(${table.quantity}) AND ${table.quantity} < 'Infinity'::numeric AND ${table.price} > 0 AND ${table.price} < 'Infinity'::numeric AND ${table.notional} = ${table.price} * ${table.quantity} AND ${table.costs} >= 0 AND ${table.costs} < 'Infinity'::numeric AND ${table.realizedPnl} > '-Infinity'::numeric AND ${table.realizedPnl} < 'Infinity'::numeric`,
    ),
    check('paper_fill_identity', sql`${table.requestHash} ~ '^[a-f0-9]{64}$' AND ${table.model} = 'quote-proxy-v1'`),
  ],
);
export const paperCostBasis = pgTable(
  'paper_cost_basis',
  {
    accountId: text('account_id')
      .notNull()
      .references(() => paperAccounts.id),
    market: marketEnum('market').notNull(),
    symbol: text('symbol').notNull(),
    strategyId: text('strategy_id').notNull(),
    quantity: numeric('quantity').notNull(),
    amount: numeric('amount').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.accountId, table.market, table.symbol, table.strategyId] }),
    check(
      'paper_basis_amounts',
      sql`${table.quantity} >= 0 AND ${table.quantity} = trunc(${table.quantity}) AND ${table.quantity} < 'Infinity'::numeric AND ${table.amount} >= 0 AND ${table.amount} < 'Infinity'::numeric AND (${table.quantity} > 0 OR ${table.amount} = 0)`,
    ),
  ],
);
