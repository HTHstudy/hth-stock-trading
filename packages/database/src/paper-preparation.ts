import { and, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import { paperRiskLimitsSchema, paperStrategyDefinitionSchema } from '@hth/contracts';
import { marketTradingDate, movingAverageCross } from '@hth/trading';
import { contentHash } from './content-hash.js';
import * as schema from './schema.js';

const inputSchema = z
  .object({
    accountId: z.string().regex(/^paper-market-[A-Za-z0-9._:-]{1,70}$/),
    planHash: z.string().regex(/^[a-f0-9]{64}$/),
    cash: z.object({ KRW: z.string().regex(/^\d{1,18}$/), USD: z.string().regex(/^\d{1,18}(\.\d{1,2})?$/) }).strict(),
    limits: paperRiskLimitsSchema,
    strategyVersion: z.literal(movingAverageCross.version),
    strategy: paperStrategyDefinitionSchema,
  })
  .strict();

export function createPaperPreparationStore(db: NodePgDatabase<typeof schema>) {
  return {
    async create(input: unknown) {
      const value = inputSchema.parse(input);
      // Bind the audit receipt to exactly the configuration written below.
      const expectedHash = contentHash({
        formatVersion: 'paper-market-plan-v1',
        mode: 'paper',
        source: 'toss-readonly',
        purpose: 'validation-only',
        executionEnabled: false,
        strategyVersion: value.strategyVersion,
        cash: value.cash,
        limits: value.limits,
        strategy: value.strategy,
      });
      if (value.planHash !== expectedHash) throw new Error('PAPER_MARKET_PLAN_HASH_MISMATCH');
      const money = value.strategy.instrument.market === 'KR' ? 'KRW' : 'USD';
      if (!/[1-9]/.test(value.cash[money]) || value.strategy.parameters.slowPeriod >= 200)
        throw new Error('PAPER_PREPARATION_INVALID');
      for (const currency of ['KRW', 'USD'] as const) {
        const pattern = currency === 'KRW' ? /^\d{1,18}$/ : /^\d{1,18}(\.\d{1,2})?$/;
        if (
          ![
            value.limits[currency].maxOrderAmount,
            value.limits[currency].maxInstrumentAmount,
            value.limits[currency].maxDailyLoss,
          ].every((amount) => pattern.test(amount))
        )
          throw new Error('PAPER_PREPARATION_INVALID');
      }
      try {
        return await db.transaction(async (transaction) => {
          const time = await transaction.execute<{ instant: string }>(sql`SELECT clock_timestamp()::text AS instant`);
          const now = new Date(time.rows[0]!.instant);
          const [created] = await transaction
            .insert(schema.paperAccounts)
            .values({
              id: value.accountId,
              dataSource: 'toss-readonly',
              stopped: true,
              reason: 'PREPARED_OFFLINE',
              limits: value.limits,
              ledger: {
                cash: value.cash,
                positions: [],
                observedAt: now.toISOString(),
                reconciled: false,
                dailyPnl: {
                  KRW: { tradingDate: marketTradingDate(now.getTime(), 'KR'), netPnl: '0' },
                  USD: { tradingDate: marketTradingDate(now.getTime(), 'US'), netPnl: '0' },
                },
              },
            })
            .onConflictDoNothing()
            .returning({ id: schema.paperAccounts.id });
          if (!created) throw new Error('PAPER_MARKET_ACCOUNT_EXISTS');
          const strategy = {
            accountId: value.accountId,
            strategyId: 'market-ma',
            version: value.strategyVersion,
            enabled: true,
            revision: 1,
            definition: value.strategy,
          };
          await transaction.insert(schema.paperStrategies).values({
            ...strategy,
            definitionHash: contentHash({ version: strategy.version, definition: strategy.definition }),
          });
          await transaction.insert(schema.paperStrategyRevisions).values({
            ...strategy,
            actor: 'system',
            valueHash: contentHash({
              revision: 1,
              version: strategy.version,
              enabled: true,
              definition: strategy.definition,
            }),
          });
          await transaction.insert(schema.paperEvents).values({
            accountId: value.accountId,
            kind: 'ACCOUNT_CREATED',
            details: { source: 'toss-readonly', preparation: 'offline-v1', planHash: value.planHash },
          });
          return { prepared: true as const, executionEnabled: false as const };
        });
      } catch (error) {
        throw new Error(
          error instanceof Error && error.message === 'PAPER_MARKET_ACCOUNT_EXISTS'
            ? error.message
            : 'PAPER_PREPARATION_STORAGE_FAILED',
        );
      }
    },
    async read(accountId: string) {
      inputSchema.shape.accountId.parse(accountId);
      return db.transaction(
        async (transaction) => {
          const time = await transaction.execute<{ instant: string }>(sql`SELECT clock_timestamp()::text AS instant`);
          const asOf = new Date(time.rows[0]!.instant).toISOString();
          const [account] = await transaction
            .select()
            .from(schema.paperAccounts)
            .where(eq(schema.paperAccounts.id, accountId));
          if (!account) throw new Error('PAPER_ACCOUNT_NOT_FOUND');
          const strategies = await transaction
            .select()
            .from(schema.paperStrategies)
            .where(eq(schema.paperStrategies.accountId, accountId))
            .limit(2);
          const revisions = await transaction
            .select()
            .from(schema.paperStrategyRevisions)
            .where(eq(schema.paperStrategyRevisions.accountId, accountId))
            .limit(2);
          const receipts = await transaction
            .select({ details: schema.paperEvents.details })
            .from(schema.paperEvents)
            .where(and(eq(schema.paperEvents.accountId, accountId), eq(schema.paperEvents.kind, 'ACCOUNT_CREATED')))
            .limit(2);
          const counts = await transaction.execute<{ orders: string; fills: string; reservations: string }>(sql`
          SELECT (SELECT count(*) FROM ${schema.paperIntents} WHERE ${schema.paperIntents.accountId} = ${accountId})::text AS orders,
                 (SELECT count(*) FROM ${schema.paperFills} WHERE ${schema.paperFills.accountId} = ${accountId})::text AS fills,
                 (SELECT count(*) FROM ${schema.paperReservations} WHERE ${schema.paperReservations.accountId} = ${accountId})::text AS reservations`);
          return { asOf, account, strategies, revisions, receipts, counts: counts.rows[0]! };
        },
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
      );
    },
  };
}
