import { eq, sql, asc, and } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  paperReviewSnapshotSchema,
  paperReviewCheckpointSchema,
  paperRunDiagnosticsArtifactSchema,
} from '@hth/contracts';
import type { PaperDataSource } from '@hth/contracts';
import { contentHash, normalizeDecimal } from './content-hash.js';
import { readPaperReviewEvents } from './paper-review-events.js';
import * as tables from './schema.js';

const key = (value: string) => contentHash(value);
export function createPaperReviewStore(db: NodePgDatabase<typeof tables>, connectionString: string) {
  return {
    async captureDiagnostics(accountId: string, beforeInput: unknown, afterInput: unknown) {
      const before = paperReviewCheckpointSchema.parse(beforeInput),
        after = paperReviewCheckpointSchema.parse(afterInput);
      if (
        !/^paper-market-[A-Za-z0-9._:-]{1,70}$/.test(accountId) ||
        contentHash(before.snapshot) !== before.hash ||
        contentHash(after.snapshot) !== after.hash
      )
        throw new Error('PAPER_REVIEW_SCOPE_INVALID');
      return db.transaction(
        async (tx) => {
          await tx.execute(sql`SET LOCAL statement_timeout = '3s'`);
          const identity = await tx.execute<{ name: string; role: string; as_of: string }>(
            sql`SELECT current_database() AS name, current_user AS role, to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS as_of`,
          );
          const info = identity.rows[0]!;
          if (info.name !== 'hth_readonly_test' || info.role !== 'hth_test')
            throw new Error('PAPER_REVIEW_DATABASE_INVALID');
          const target = new URL(connectionString);
          const scope = contentHash({
            accountId,
            source: 'toss-readonly',
            host: target.hostname === 'localhost' ? '127.0.0.1' : target.hostname,
            port: target.port || '5432',
            database: info.name,
            role: info.role,
          });
          const [account] = await tx.select().from(tables.paperAccounts).where(eq(tables.paperAccounts.id, accountId));
          if (
            !account ||
            account.mode !== 'paper' ||
            account.dataSource !== 'toss-readonly' ||
            before.snapshot.scope !== scope ||
            after.snapshot.scope !== scope ||
            before.snapshot.source !== 'toss-readonly' ||
            after.snapshot.source !== 'toss-readonly'
          )
            throw new Error('PAPER_REVIEW_SCOPE_INVALID');
          const prior = new Set(before.snapshot.events.map((event) => event.key));
          const expected = new Set(
            after.snapshot.events
              .filter((event) => event.kind === 'STRATEGY_DIAGNOSED' && !prior.has(event.key))
              .map((event) => event.key),
          );
          const rows = await tx
            .select({ id: tables.paperEvents.id, details: tables.paperEvents.details })
            .from(tables.paperEvents)
            .where(and(eq(tables.paperEvents.accountId, accountId), eq(tables.paperEvents.kind, 'STRATEGY_DIAGNOSED')))
            .orderBy(asc(tables.paperEvents.createdAt), asc(tables.paperEvents.id))
            .limit(5001);
          if (rows.length > 5000) throw new Error('PAPER_REVIEW_LIMIT_EXCEEDED');
          const body = {
            formatVersion: 'paper-run-diagnostics-v1',
            beforeHash: before.hash,
            afterHash: after.hash,
            scope,
            capturedAt: info.as_of,
            events: rows
              .filter((row) => expected.has(contentHash(row.id)))
              .map((row) => ({ key: contentHash(row.id), batch: row.details.batch, batchHash: row.details.batchHash })),
          };
          if (body.events.length !== expected.size) throw new Error('PAPER_REVIEW_DIAGNOSTICS_MISSING');
          return paperRunDiagnosticsArtifactSchema.parse({ ...body, hash: contentHash(body) });
        },
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
      );
    },
    async capture(accountId: string, source: Exclude<PaperDataSource, 'unverified'>) {
      if (!/^[A-Za-z0-9._:-]{1,100}$/.test(accountId)) throw new Error('PAPER_REVIEW_SCOPE_INVALID');
      return db.transaction(
        async (tx) => {
          await tx.execute(sql`SET LOCAL statement_timeout = '3s'`);
          const identity = await tx.execute<{ name: string; role: string; as_of: string }>(
            sql`SELECT current_database() AS name, current_user AS role, to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS as_of`,
          );
          const info = identity.rows[0]!;
          if (info.name !== 'hth_readonly_test' || info.role !== 'hth_test')
            throw new Error('PAPER_REVIEW_DATABASE_INVALID');
          const [account] = await tx.select().from(tables.paperAccounts).where(eq(tables.paperAccounts.id, accountId));
          if (
            !account ||
            account.mode !== 'paper' ||
            account.dataSource !== source ||
            !['synthetic-only', 'toss-readonly'].includes(source)
          )
            throw new Error('PAPER_REVIEW_SCOPE_INVALID');
          const intents = await tx
            .select()
            .from(tables.paperIntents)
            .where(eq(tables.paperIntents.accountId, accountId))
            .orderBy(asc(tables.paperIntents.intentId))
            .limit(5001);
          const fills = await tx
            .select({
              key: tables.paperFills.fillId,
              intentId: tables.paperFills.intentId,
              requestHash: tables.paperFills.requestHash,
              quantity: tables.paperFills.quantity,
              price: tables.paperFills.price,
              notional: tables.paperFills.notional,
              costs: tables.paperFills.costs,
              realizedPnl: tables.paperFills.realizedPnl,
              createdAt: sql<string>`to_char(${tables.paperFills.createdAt} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
            })
            .from(tables.paperFills)
            .where(eq(tables.paperFills.accountId, accountId))
            .orderBy(asc(tables.paperFills.createdAt), asc(tables.paperFills.fillId))
            .limit(5001);
          const reservations = await tx
            .select()
            .from(tables.paperReservations)
            .where(eq(tables.paperReservations.accountId, accountId))
            .orderBy(asc(tables.paperReservations.intentId))
            .limit(5001);
          const basis = await tx
            .select()
            .from(tables.paperCostBasis)
            .where(eq(tables.paperCostBasis.accountId, accountId))
            .orderBy(
              asc(tables.paperCostBasis.market),
              asc(tables.paperCostBasis.symbol),
              asc(tables.paperCostBasis.strategyId),
            )
            .limit(5001);
          const strategies = await tx
            .select()
            .from(tables.paperStrategies)
            .where(eq(tables.paperStrategies.accountId, accountId))
            .orderBy(asc(tables.paperStrategies.strategyId))
            .limit(5001);
          const events = await readPaperReviewEvents(tx, accountId);
          if ([intents, fills, reservations, basis, strategies, events].some((rows) => rows.length > 5000))
            throw new Error('PAPER_REVIEW_LIMIT_EXCEEDED');
          const target = new URL(connectionString);
          return paperReviewSnapshotSchema.parse({
            formatVersion: 'paper-review-snapshot-v1',
            source,
            scope: contentHash({
              accountId,
              source,
              host: target.hostname === 'localhost' ? '127.0.0.1' : target.hostname,
              port: target.port || '5432',
              database: info.name,
              role: info.role,
            }),
            asOf: info.as_of,
            version: account.version,
            epoch: account.epoch,
            stopped: account.stopped,
            leasePresent: account.leaseToken !== null || account.leaseUntil !== null,
            limitsHash: contentHash(account.limits),
            strategyHash: contentHash(
              strategies.map((s) => ({
                key: key(s.strategyId),
                version: s.version,
                enabled: s.enabled,
                revision: s.revision,
                definitionHash: s.definitionHash,
              })),
            ),
            cash: account.ledger.cash,
            dailyPnl: account.ledger.dailyPnl,
            positions: account.ledger.positions.map((p) => ({
              instrument: p.instrument,
              quantity: normalizeDecimal(p.quantity),
              manualQuantity: normalizeDecimal(p.manualQuantity),
              sellableQuantity: normalizeDecimal(p.sellableQuantity),
              ownership: p.ownership.map((o) => ({
                strategyKey: key(o.strategyId),
                quantity: normalizeDecimal(o.quantity),
              })),
            })),
            basis: basis.map((b) => ({
              instrument: { market: b.market, symbol: b.symbol },
              strategyKey: key(b.strategyId),
              quantity: normalizeDecimal(b.quantity),
              amount: b.amount,
            })),
            intents: intents.map((row) => {
              const { intentId, ...economics } = row.candidate;
              const s = row.signal;
              return {
                key: key(row.intentId),
                dedupeKey: row.dedupeKey,
                requestHash: row.requestHash,
                requestVerified:
                  intentId === row.intentId &&
                  row.candidate.accountId === accountId &&
                  row.requestHash === contentHash({ candidate: economics, signal: s }),
                dedupeVerified:
                  row.dedupeKey ===
                  contentHash({
                    strategyId: row.candidate.strategyId,
                    instrument: row.candidate.instrument,
                    side: row.candidate.side,
                    strategyVersion: s.strategyVersion,
                    barTimestamp: s.barTimestamp,
                    interval: s.interval,
                    adjusted: s.adjusted,
                    source: s.source,
                  }),
                strategyKey: key(row.candidate.strategyId),
                instrument: row.candidate.instrument,
                side: row.candidate.side,
                quantity: normalizeDecimal(row.candidate.quantity),
                filledQuantity: normalizeDecimal(row.filledQuantity),
                filledNotional: row.filledNotional,
                paidCosts: row.paidCosts,
                state: row.state,
              };
            }),
            fills: fills.map((f) => ({
              key: key(f.key),
              intentKey: key(f.intentId),
              requestHash: f.requestHash,
              requestVerified:
                f.requestHash ===
                contentHash({ intentId: f.intentId, quantity: normalizeDecimal(f.quantity), model: 'quote-proxy-v1' }),
              quantity: normalizeDecimal(f.quantity),
              price: f.price,
              notional: f.notional,
              costs: f.costs,
              realizedPnl: f.realizedPnl,
              createdAt: f.createdAt,
            })),
            reservations: reservations.map((r) => ({
              intentKey: key(r.intentId),
              quantity: normalizeDecimal(r.quantity),
              cashAmount: r.cashAmount,
              sellQuantity: normalizeDecimal(r.sellQuantity),
              active: r.active,
            })),
            events,
          });
        },
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
      );
    },
  };
}
