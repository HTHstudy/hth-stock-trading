import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, lt, ne, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import {
  paperEvidenceSchema,
  paperDataSourceSchema,
  paperDiagnosticBatchSchema,
  paperDiagnosticReportSchema,
  paperDiagnosticsSchema,
  paperEquityPointSchema,
  paperEquityHistorySchema,
  paperExecutionSourceSchema,
  paperDashboardSnapshotSchema,
  paperReasonSchema,
  paperEventKindSchema,
  riskBlockerSchema,
  paperStrategyDefinitionSchema,
  paperStrategyHistorySchema,
  paperStrategyHistoryQuerySchema,
  paperStrategyUpdateSchema,
  paperObservationSchema,
  paperFillRequestSchema,
  paperLedgerStateSchema,
  paperOrderCandidateSchema,
  paperRecordedOrderSchema,
  paperRiskLimitsSchema,
  paperRiskSnapshotSchema,
} from '@hth/contracts';
import type { PaperDataSource, PaperLedgerState, PaperRiskSnapshot, PaperStrategyDefinition } from '@hth/contracts';
import {
  evaluatePaperRisk,
  isPaperRiskCurrent,
  prepareStrategyData,
  settlePaperFill,
  observePaperLedger,
  reviewPaperTradingDay,
  paperPortfolios,
  paperEquityValues,
  paperEquityChange,
  paperPositionValue,
  marketTradingDate,
  movingAverageCross,
} from '@hth/trading';
import type * as schema from './schema.js';
import {
  paperAccounts,
  paperEvents,
  paperIntents,
  paperReservations,
  paperStrategies,
  paperFills,
  paperCostBasis,
  paperStrategyRevisions,
} from './schema.js';
import { contentHash, normalizeDecimal } from './content-hash.js';

type Database = NodePgDatabase<typeof schema>;
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type Account = typeof paperAccounts.$inferSelect;
type Intent = typeof paperIntents.$inferSelect;
function assertSource(account: Account, source: PaperDataSource) {
  if (source === 'unverified' || account.dataSource !== source) throw new Error('PAPER_SOURCE_MISMATCH');
}
function assertCandleSource(account: Account, sources: readonly string[]) {
  if (
    !sources.length ||
    account.dataSource === 'unverified' ||
    sources.some((source) =>
      account.dataSource === 'toss-readonly' ? source !== 'toss' : !source.startsWith('synthetic-'),
    )
  )
    throw new Error('PAPER_SOURCE_MISMATCH');
}
const accountIdSchema = paperOrderCandidateSchema.shape.accountId;
const versionSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER - 2);
const reasonSchema = z.string().trim().min(1).max(200);
const ttlSchema = z.number().int().min(1000).max(60_000);
const openStates = ['INTENT_RECORDED', 'READY', 'PARTIALLY_FILLED'] as const;

function parse<Schema extends z.ZodType>(definition: Schema, input: unknown): z.output<Schema> {
  const result = definition.safeParse(input);
  if (!result.success) throw new Error('PAPER_INPUT_INVALID');
  return result.data;
}
async function safe<Result>(operation: () => Promise<Result>): Promise<Result> {
  try {
    return await operation();
  } catch (error) {
    throw new Error(
      error instanceof Error && /^PAPER_[A-Z_]+$/.test(error.message) ? error.message : 'PAPER_STORAGE_FAILED',
    );
  }
}
async function clock(transaction: Transaction) {
  const result = await transaction.execute<{ milliseconds: string }>(
    sql`SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::text AS milliseconds`,
  );
  return new Date(Number(result.rows[0]!.milliseconds));
}
function leaseOwned(account: Account, token: string, now: Date) {
  return account.leaseToken === token && account.leaseUntil !== null && Date.parse(account.leaseUntil) > now.getTime();
}
function expected(account: Account, version: number) {
  if (account.version !== parse(versionSchema, version)) throw new Error('PAPER_VERSION_CONFLICT');
}
function checkLimits(value: unknown) {
  const limits = parse(paperRiskLimitsSchema, value);
  for (const currency of ['KRW', 'USD'] as const)
    for (const amount of [
      limits[currency].maxOrderAmount,
      limits[currency].maxInstrumentAmount,
      limits[currency].maxDailyLoss,
    ]) {
      if (/[1-9]/.test((amount.split('.')[1] ?? '').slice(currency === 'KRW' ? 0 : 2)))
        throw new Error('PAPER_LIMITS_INVALID');
    }
  return limits;
}

function valuationStale(ledger: PaperLedgerState, now: Date) {
  return (
    ledger.positions.some((position) =>
      [position.markTimestamp, position.markObservedAt].some(
        (instant) =>
          instant === null ||
          now.getTime() - Date.parse(instant) >= 120_000 ||
          Date.parse(instant) > now.getTime() + 5000,
      ),
    ) ||
    ledger.dailyPnl.KRW.tradingDate !== marketTradingDate(now.getTime(), 'KR') ||
    ledger.dailyPnl.USD.tradingDate !== marketTradingDate(now.getTime(), 'US') ||
    !ledger.reconciled ||
    now.getTime() - Date.parse(ledger.observedAt) >= 60_000 ||
    Date.parse(ledger.observedAt) > now.getTime() + 5000
  );
}
function equityDetails(account: Account, now: Date) {
  const equityPoint = paperEquityPointSchema.parse({
    formatVersion: 'paper-equity-v1',
    version: account.version,
    source: account.dataSource,
    recordedAt: now.toISOString(),
    observedAt: account.ledger.observedAt,
    reconciled: account.ledger.reconciled,
    stale: valuationStale(account.ledger, now),
    values: paperEquityValues(account.ledger),
  });
  return { equityPoint, equityHash: contentHash(equityPoint) };
}

export function createPaperLedger(db: Database) {
  async function consistent<Result>(
    id: string,
    operation: (transaction: Transaction, account: Account) => Promise<Result>,
  ) {
    parse(accountIdSchema, id);
    return safe(() =>
      db.transaction(
        async (transaction) => {
          await transaction.execute(sql`SET LOCAL statement_timeout = '3s'`);
          const [account] = await transaction.select().from(paperAccounts).where(eq(paperAccounts.id, id));
          if (!account) throw new Error('PAPER_ACCOUNT_NOT_FOUND');
          parse(paperLedgerStateSchema, account.ledger);
          return operation(transaction, account);
        },
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
      ),
    );
  }
  async function locked<Result>(
    id: string,
    operation: (transaction: Transaction, account: Account) => Promise<Result>,
  ) {
    parse(accountIdSchema, id);
    return safe(() =>
      db.transaction(async (transaction) => {
        await transaction.execute(sql`SET LOCAL lock_timeout = '5s'`);
        const [account] = await transaction.select().from(paperAccounts).where(eq(paperAccounts.id, id)).for('update');
        if (!account) throw new Error('PAPER_ACCOUNT_NOT_FOUND');
        parse(paperLedgerStateSchema, account.ledger);
        return operation(transaction, account);
      }),
    );
  }
  async function event(
    transaction: Transaction,
    accountId: string,
    kind: string,
    details: Record<string, unknown> = {},
    intentId: string | null = null,
  ) {
    await transaction.insert(paperEvents).values({ accountId, intentId, kind, details });
  }
  async function advance(
    transaction: Transaction,
    account: Account,
    change: Partial<typeof paperAccounts.$inferInsert> = {},
  ) {
    if (account.version >= Number.MAX_SAFE_INTEGER - 1 && change.stopped !== true)
      throw new Error('PAPER_VERSION_EXHAUSTED');
    const next = {
      ...change,
      ...(change.epoch === undefined ? {} : { epoch: Math.min(change.epoch, Number.MAX_SAFE_INTEGER - 1) }),
    };
    const [updated] = await transaction
      .update(paperAccounts)
      .set({ ...next, version: Math.min(account.version + 1, Number.MAX_SAFE_INTEGER - 1) })
      .where(and(eq(paperAccounts.id, account.id), eq(paperAccounts.version, account.version)))
      .returning();
    if (!updated) throw new Error('PAPER_VERSION_CONFLICT');
    return updated;
  }
  async function snapshot(transaction: Transaction, account: Account): Promise<PaperRiskSnapshot> {
    const rows = await transaction
      .select({
        order: paperIntents.candidate,
        quantity: paperReservations.quantity,
        price: paperReservations.valuationPrice,
        costBps: paperReservations.costBps,
        filledNotional: paperIntents.filledNotional,
        paidCosts: paperIntents.paidCosts,
      })
      .from(paperReservations)
      .innerJoin(
        paperIntents,
        and(
          eq(paperReservations.accountId, paperIntents.accountId),
          eq(paperReservations.intentId, paperIntents.intentId),
        ),
      )
      .where(and(eq(paperReservations.accountId, account.id), eq(paperReservations.active, true)));
    return parse(paperRiskSnapshotSchema, {
      ...account.ledger,
      mode: 'paper',
      accountId: account.id,
      version: account.version,
      reservations: rows.map((row) => ({
        intentId: row.order.intentId,
        strategyId: row.order.strategyId,
        instrument: row.order.instrument,
        side: row.order.side,
        remainingQuantity: normalizeDecimal(row.quantity),
        limitPrice: normalizeDecimal(row.price),
        costBps: normalizeDecimal(row.costBps),
        filledNotional: normalizeDecimal(row.filledNotional),
        paidCosts: normalizeDecimal(row.paidCosts),
      })),
    });
  }
  async function findIntent(transaction: Transaction, accountId: string, intentId: string) {
    parse(accountIdSchema, intentId);
    const [intent] = await transaction
      .select()
      .from(paperIntents)
      .where(and(eq(paperIntents.accountId, accountId), eq(paperIntents.intentId, intentId)));
    if (!intent) throw new Error('PAPER_INTENT_NOT_FOUND');
    return intent;
  }
  async function abortLocked(transaction: Transaction, account: Account, intent: Intent, reason: string) {
    if (!openStates.includes(intent.state as (typeof openStates)[number])) return intent;
    await transaction
      .update(paperReservations)
      .set({ active: false })
      .where(
        and(
          eq(paperReservations.accountId, account.id),
          eq(paperReservations.intentId, intent.intentId),
          eq(paperReservations.active, true),
        ),
      );
    const [updated] = await transaction
      .update(paperIntents)
      .set({ state: 'ABORTED', version: intent.version + 1, codes: [reason] })
      .where(
        and(
          eq(paperIntents.accountId, account.id),
          eq(paperIntents.intentId, intent.intentId),
          eq(paperIntents.version, intent.version),
        ),
      )
      .returning();
    await advance(transaction, account);
    await event(transaction, account.id, 'INTENT_ABORTED', { reason }, intent.intentId);
    return updated!;
  }
  function owned(account: Account, token: string, epoch: number, now: Date) {
    if (!leaseOwned(account, token, now)) throw new Error('PAPER_LEASE_NOT_OWNED');
    if (account.epoch !== epoch) throw new Error('PAPER_CONTROL_CHANGED');
  }
  async function drain(transaction: Transaction, account: Account, reason: string) {
    const intents = await transaction
      .select()
      .from(paperIntents)
      .where(and(eq(paperIntents.accountId, account.id), inArray(paperIntents.state, [...openStates])));
    if (!intents.length) return;
    await transaction
      .update(paperReservations)
      .set({ active: false })
      .where(and(eq(paperReservations.accountId, account.id), eq(paperReservations.active, true)));
    await transaction
      .update(paperIntents)
      .set({ state: 'ABORTED', version: sql`${paperIntents.version} + 1`, codes: [reason] })
      .where(and(eq(paperIntents.accountId, account.id), inArray(paperIntents.state, [...openStates])));
    for (const intent of intents) await event(transaction, account.id, 'INTENT_ABORTED', { reason }, intent.intentId);
  }
  return {
    async createAccount(id: string, value: unknown, source: PaperDataSource = 'unverified') {
      const dataSource = parse(paperDataSourceSchema, source);
      parse(accountIdSchema, id);
      const state = parse(paperLedgerStateSchema, value);
      if (
        state.positions.some(
          (position) =>
            normalizeDecimal(position.quantity) !== normalizeDecimal(position.manualQuantity) ||
            position.ownership.some((owner) => /[1-9]/.test(owner.quantity)),
        )
      )
        throw new Error('PAPER_INITIAL_OWNERSHIP_MUST_BE_MANUAL');
      const ledger: PaperLedgerState = {
        ...state,
        reconciled: false,
        positions: state.positions.map((position) => ({ ...position, ownership: [] })),
      };
      return safe(() =>
        db.transaction(async (transaction) => {
          const [created] = await transaction
            .insert(paperAccounts)
            .values({ id, ledger, dataSource })
            .onConflictDoNothing()
            .returning();
          if (created) await event(transaction, id, 'ACCOUNT_CREATED', { source: dataSource });
          else {
            const [existing] = await transaction.select().from(paperAccounts).where(eq(paperAccounts.id, id));
            if (existing?.dataSource !== dataSource) throw new Error('PAPER_SOURCE_MISMATCH');
          }
          return { created: Boolean(created), executionEnabled: false as const };
        }),
      );
    },
    async readAccount(id: string) {
      return locked(id, async (transaction, account) => ({
        source: account.dataSource,
        asOf: (await clock(transaction)).toISOString(),
        control: { mode: 'paper' as const, stopped: account.stopped, epoch: account.epoch, reason: account.reason },
        limits: account.limits,
        snapshot: await snapshot(transaction, account),
        leaseUntil: account.leaseUntil,
      }));
    },
    async readStrategies(id: string) {
      return locked(id, (transaction) =>
        transaction
          .select({
            id: paperStrategies.strategyId,
            version: paperStrategies.version,
            enabled: paperStrategies.enabled,
            revision: paperStrategies.revision,
            definition: paperStrategies.definition,
            definitionHash: paperStrategies.definitionHash,
          })
          .from(paperStrategies)
          .where(eq(paperStrategies.accountId, id)),
      );
    },
    async recordDiagnostics(id: string, token: string, epoch: number, source: PaperDataSource, value: unknown) {
      const reports = parse(z.array(paperDiagnosticReportSchema).min(1).max(100), value);
      parse(z.uuid(), token);
      parse(versionSchema, epoch);
      parse(paperExecutionSourceSchema, source);
      return locked(id, async (transaction, account) => {
        assertSource(account, source);
        const now = await clock(transaction);
        owned(account, token, epoch, now);
        const stored = await transaction.select().from(paperStrategies).where(eq(paperStrategies.accountId, id));
        for (const report of reports) {
          const strategy = stored.find((item) => item.strategyId === report.strategyId);
          if (
            !strategy ||
            strategy.version !== report.strategyVersion ||
            strategy.revision !== report.strategyRevision ||
            (strategy.definition &&
              (strategy.definition.instrument.market !== report.instrument.market ||
                strategy.definition.instrument.symbol !== report.instrument.symbol)) ||
            now.getTime() - Date.parse(report.evaluatedAt) >= 60000 ||
            Date.parse(report.evaluatedAt) > now.getTime() + 5000
          )
            throw new Error('PAPER_DIAGNOSTIC_MISMATCH');
        }
        const batch = paperDiagnosticBatchSchema.parse({
          formatVersion: 'paper-diagnostics-v1',
          recordedAt: now.toISOString(),
          source,
          epoch,
          accountVersion: account.version,
          reports,
        });
        await event(transaction, id, 'STRATEGY_DIAGNOSED', { batch, batchHash: contentHash(batch) });
        owned(account, token, epoch, await clock(transaction));
      });
    },
    async readDiagnostics(id: string) {
      return consistent(id, async (transaction, account) => {
        const now = await clock(transaction);
        const stored = await transaction
          .select()
          .from(paperStrategies)
          .where(eq(paperStrategies.accountId, id))
          .orderBy(paperStrategies.strategyId)
          .limit(101);
        const rows = await transaction
          .select({ details: paperEvents.details })
          .from(paperEvents)
          .where(and(eq(paperEvents.accountId, id), eq(paperEvents.kind, 'STRATEGY_DIAGNOSED')))
          .orderBy(desc(paperEvents.createdAt), desc(paperEvents.id))
          .limit(21);
        const latest = new Map<string, { report: z.infer<typeof paperDiagnosticReportSchema>; recordedAt: string }>();
        for (const row of rows.slice(0, 20)) {
          const batch = paperDiagnosticBatchSchema.parse(row.details.batch);
          if (
            contentHash(batch) !== row.details.batchHash ||
            batch.source !== account.dataSource ||
            batch.accountVersion > account.version ||
            batch.epoch > account.epoch
          )
            throw new Error('PAPER_DIAGNOSTICS_INVALID');
          for (const report of batch.reports)
            if (!latest.has(report.strategyId)) latest.set(report.strategyId, { report, recordedAt: batch.recordedAt });
        }
        return paperDiagnosticsSchema.parse({
          mode: 'paper',
          executionEnabled: false,
          source: account.dataSource,
          asOf: now.toISOString(),
          stopped: account.stopped,
          workerState:
            account.leaseUntil === null
              ? 'absent'
              : Date.parse(account.leaseUntil) > now.getTime()
                ? 'active'
                : 'expired',
          limited: stored.length > 100 || rows.length > 20,
          items: stored.slice(0, 100).map((strategy) => {
            const record = latest.get(strategy.strategyId) ?? null;
            return {
              strategy: {
                id: strategy.strategyId,
                version: strategy.version,
                enabled: strategy.enabled,
                revision: strategy.revision,
                definition: strategy.definition,
              },
              latest: record,
              configurationCurrent: record
                ? record.report.strategyVersion === strategy.version &&
                  record.report.strategyRevision === strategy.revision
                : null,
              stale: record
                ? now.getTime() - Date.parse(record.recordedAt) >= 60000 ||
                  Date.parse(record.recordedAt) > now.getTime() + 5000
                : null,
            };
          }),
        });
      });
    },
    async readEquityHistory(id: string) {
      return consistent(id, async (transaction, account) => {
        const scope = and(
          eq(paperEvents.accountId, id),
          inArray(paperEvents.kind, ['ACCOUNT_OBSERVED', 'PAPER_FILL_RECORDED', 'ACCOUNT_RECONCILED']),
          sql`${paperEvents.details} ? 'equityPoint'`,
        );
        const version = sql`(${paperEvents.details}->'equityPoint'->>'version')::bigint`;
        const [first] = await transaction
          .select({ details: paperEvents.details })
          .from(paperEvents)
          .where(scope)
          .orderBy(version)
          .limit(1);
        const rows = await transaction
          .select({ details: paperEvents.details })
          .from(paperEvents)
          .where(scope)
          .orderBy(sql`${version} DESC`)
          .limit(501);
        const verify = (details: Record<string, unknown>) => {
          const point = paperEquityPointSchema.parse(details.equityPoint);
          if (
            point.source !== account.dataSource ||
            point.version > account.version ||
            contentHash(point) !== details.equityHash
          )
            throw new Error('PAPER_EQUITY_HISTORY_INVALID');
          return point;
        };
        const baseline = first ? verify(first.details) : null;
        const checked = rows.map((row) => verify(row.details));
        return paperEquityHistorySchema.parse({
          mode: 'paper',
          executionEnabled: false,
          source: account.dataSource,
          baseline,
          points: checked
            .slice(0, 500)
            .reverse()
            .map((point) => ({
              point,
              changePercent: point.values.map((item, index) =>
                paperEquityChange(item.equity, baseline!.values[index]!.equity),
              ),
            })),
          limited: rows.length > 500,
        });
      });
    },
    async readStrategyHistory(id: string, strategyId: string, query: unknown = {}) {
      parse(accountIdSchema, strategyId);
      const { beforeRevision } = parse(paperStrategyHistoryQuerySchema, query);
      return consistent(id, async (transaction, account) => {
        const [current] = await transaction
          .select()
          .from(paperStrategies)
          .where(and(eq(paperStrategies.accountId, id), eq(paperStrategies.strategyId, strategyId)));
        if (!current) throw new Error('PAPER_STRATEGY_NOT_FOUND');
        const scope = and(eq(paperStrategyRevisions.accountId, id), eq(paperStrategyRevisions.strategyId, strategyId));
        const rows = await transaction
          .select()
          .from(paperStrategyRevisions)
          .where(
            and(scope, beforeRevision === undefined ? undefined : lt(paperStrategyRevisions.revision, beforeRevision)),
          )
          .orderBy(desc(paperStrategyRevisions.revision))
          .limit(21);
        const expectedFirst = Math.min(
          current.revision,
          beforeRevision === undefined ? current.revision : beforeRevision - 1,
        );
        if (rows.length !== Math.min(21, expectedFirst)) throw new Error('PAPER_STRATEGY_HISTORY_INVALID');
        for (let index = 0; index < rows.length; index++) {
          const row = rows[index]!;
          if (
            row.revision !== expectedFirst - index ||
            row.valueHash !==
              contentHash({
                revision: row.revision,
                version: row.version,
                enabled: row.enabled,
                definition: row.definition,
              })
          )
            throw new Error('PAPER_STRATEGY_HISTORY_INVALID');
        }
        if (current.revision > 0) {
          const [latest] = await transaction
            .select()
            .from(paperStrategyRevisions)
            .where(and(scope, eq(paperStrategyRevisions.revision, current.revision)));
          if (
            !latest ||
            latest.valueHash !==
              contentHash({
                revision: current.revision,
                version: current.version,
                enabled: current.enabled,
                definition: current.definition,
              }) ||
            current.definitionHash !== contentHash({ version: current.version, definition: current.definition })
          )
            throw new Error('PAPER_STRATEGY_HISTORY_INVALID');
        }
        const entries = rows.slice(0, 20).map(({ revision, version, enabled, definition, actor, createdAt }) => ({
          revision,
          version,
          enabled,
          definition,
          actor,
          createdAt: new Date(createdAt).toISOString(),
        }));
        return paperStrategyHistorySchema.parse({
          mode: 'paper',
          executionEnabled: false,
          source: account.dataSource,
          strategy: {
            id: current.strategyId,
            version: current.version,
            enabled: current.enabled,
            revision: current.revision,
            definition: current.definition,
          },
          beforeRevision: beforeRevision ?? null,
          entries,
          nextBeforeRevision: rows.length > 20 ? entries.at(-1)!.revision : null,
        });
      });
    },
    async readDashboard(id: string) {
      return consistent(id, async (transaction, account) => {
        const now = await clock(transaction);
        const state = await snapshot(transaction, account);
        const orders = await transaction
          .select({
            id: paperIntents.intentId,
            candidate: paperIntents.candidate,
            state: paperIntents.state,
            filledQuantity: paperIntents.filledQuantity,
            filledNotional: paperIntents.filledNotional,
            paidCosts: paperIntents.paidCosts,
            codes: paperIntents.codes,
            createdAt: paperIntents.createdAt,
          })
          .from(paperIntents)
          .where(eq(paperIntents.accountId, id))
          .orderBy(sql`${paperIntents.createdAt} DESC NULLS LAST`, sql`${paperIntents.intentId} DESC NULLS LAST`)
          .limit(51);
        const fills = await transaction
          .select({
            id: paperFills.fillId,
            orderId: paperFills.intentId,
            candidate: paperIntents.candidate,
            quantity: paperFills.quantity,
            price: paperFills.price,
            costs: paperFills.costs,
            realizedPnl: paperFills.realizedPnl,
            createdAt: paperFills.createdAt,
          })
          .from(paperFills)
          .innerJoin(
            paperIntents,
            and(eq(paperFills.accountId, paperIntents.accountId), eq(paperFills.intentId, paperIntents.intentId)),
          )
          .where(eq(paperFills.accountId, id))
          .orderBy(sql`${paperFills.createdAt} DESC NULLS LAST`, sql`${paperFills.fillId} DESC NULLS LAST`)
          .limit(51);
        const events = await transaction
          .select({
            id: paperEvents.id,
            orderId: paperEvents.intentId,
            kind: paperEvents.kind,
            codes: sql<unknown>`${paperEvents.details}->'codes'`,
            code: sql<unknown>`${paperEvents.details}->>'code'`,
            reason: sql<unknown>`${paperEvents.details}->>'reason'`,
            createdAt: paperEvents.createdAt,
          })
          .from(paperEvents)
          .where(
            and(
              eq(paperEvents.accountId, id),
              ne(paperEvents.kind, 'ACCOUNT_OBSERVED'),
              ne(paperEvents.kind, 'STRATEGY_DIAGNOSED'),
            ),
          )
          .orderBy(sql`${paperEvents.createdAt} DESC NULLS LAST`, sql`${paperEvents.id} DESC NULLS LAST`)
          .limit(51);
        const strategies = await transaction
          .select({
            id: paperStrategies.strategyId,
            version: paperStrategies.version,
            enabled: paperStrategies.enabled,
            revision: paperStrategies.revision,
            definition: paperStrategies.definition,
          })
          .from(paperStrategies)
          .where(eq(paperStrategies.accountId, id))
          .orderBy(paperStrategies.strategyId);
        const allowedCodes = new Set([
          'STALE_RESERVATION',
          'CONTROL_CHANGED',
          'EXPIRED_BEFORE_READY',
          'WORKER_RECOVERY',
          'WORKER_EXPIRED',
          'WORKER_SHUTDOWN',
          'WORKER_FINISHED',
          'WORKER_STEP_FAILED',
          'WORKER_FAILED',
          'PAPER_SOURCE_MISMATCH',
          'PAPER_MARKET_EMERGENCY_STOP',
          'SOURCE_UNVERIFIED',
          'PAPER_LEASE_NOT_OWNED',
          'PAPER_FILL_STATE_INVALID',
          'PAPER_RESERVATION_STALE',
          'PAPER_STRATEGY_DISABLED',
          'PAPER_STRATEGY_CONFIG_MISMATCH',
          'PAPER_FILL_DATA_NOT_READY',
          'PAPER_FILL_QUANTITY_INVALID',
          'PAPER_BASIS_MISMATCH',
          'PAPER_INSUFFICIENT_CASH',
          'PAPER_INSUFFICIENT_OWNED_QUANTITY',
          'PAPER_DAILY_LOSS_LIMIT',
          'PAPER_FILL_INVALID',
        ]);
        const codes = (values: unknown[]) =>
          values
            .filter(
              (value): value is string =>
                typeof value === 'string' && (allowedCodes.has(value) || riskBlockerSchema.safeParse(value).success),
            )
            .slice(0, 100);
        const reason = paperReasonSchema.safeParse(account.reason);
        return paperDashboardSnapshotSchema.parse({
          source: account.dataSource,
          asOf: now.toISOString(),
          control: { stopped: account.stopped, epoch: account.epoch, reason: reason.success ? reason.data : 'OTHER' },
          worker: {
            state:
              account.leaseUntil === null
                ? 'absent'
                : Date.parse(account.leaseUntil) > now.getTime()
                  ? 'active'
                  : 'expired',
            leaseUntil: account.leaseUntil === null ? null : new Date(account.leaseUntil).toISOString(),
          },
          valuation: {
            observedAt: state.observedAt,
            stale: valuationStale(state, now),
            reconciled: state.reconciled,
          },
          portfolios: paperPortfolios(state),
          positions: state.positions.map((position) => ({
            instrument: position.instrument,
            quantity: position.quantity,
            manualQuantity: position.manualQuantity,
            sellableQuantity: position.sellableQuantity,
            ownership: position.ownership,
            markPrice: position.markPrice,
            value: paperPositionValue(position.quantity, position.markPrice),
          })),
          strategies,
          orders: orders.slice(0, 50).map((order) => ({
            id: order.id,
            strategyId: order.candidate.strategyId,
            instrument: order.candidate.instrument,
            side: order.candidate.side,
            quantity: order.candidate.quantity,
            limitPrice: order.candidate.limitPrice,
            filledQuantity: order.filledQuantity,
            filledNotional: order.filledNotional,
            paidCosts: order.paidCosts,
            state: order.state,
            codes: codes(order.codes),
            createdAt: new Date(order.createdAt).toISOString(),
          })),
          fills: fills.slice(0, 50).map((fill) => ({
            id: fill.id,
            orderId: fill.orderId,
            instrument: fill.candidate.instrument,
            side: fill.candidate.side,
            quantity: fill.quantity,
            price: fill.price,
            costs: fill.costs,
            realizedPnl: fill.realizedPnl,
            createdAt: new Date(fill.createdAt).toISOString(),
          })),
          events: events.slice(0, 50).map((event) => ({
            id: event.id,
            orderId: event.orderId,
            kind: paperEventKindSchema.safeParse(event.kind).success ? event.kind : 'OTHER',
            codes: codes([...(Array.isArray(event.codes) ? event.codes : []), event.code, event.reason]),
            createdAt: new Date(event.createdAt).toISOString(),
          })),
          history: {
            limit: 50,
            ordersLimited: orders.length > 50,
            fillsLimited: fills.length > 50,
            eventsLimited: events.length > 50,
          },
        });
      });
    },
    async recoverLease(id: string, token: string, epoch: number) {
      parse(z.uuid(), token);
      parse(versionSchema, epoch);
      return locked(id, async (transaction, account) => {
        owned(account, token, epoch, await clock(transaction));
        if (!account.stopped) throw new Error('PAPER_RECOVERY_REQUIRES_STOP');
        await drain(transaction, account, 'WORKER_RECOVERY');
        await advance(transaction, account);
        await event(transaction, id, 'WORKER_RECOVERED');
        owned(account, token, epoch, await clock(transaction));
      });
    },
    async parkForMarket(id: string, token: string, epoch: number) {
      parse(z.uuid(), token);
      parse(versionSchema, epoch);
      return locked(id, async (transaction, account) => {
        owned(account, token, epoch, await clock(transaction));
        await drain(transaction, account, 'MARKET_CLOSED');
        const updated = await advance(transaction, account, {
          stopped: true,
          epoch: account.epoch + 1,
          reason: 'MARKET_CLOSED',
        });
        await event(transaction, id, 'PAPER_STOPPED', { reason: 'MARKET_CLOSED', epoch: updated.epoch });
        owned(updated, token, updated.epoch, await clock(transaction));
        return updated.epoch;
      });
    },
    async reviewTradingDay(id: string, token: string, epoch: number, value: unknown) {
      parse(z.uuid(), token);
      parse(versionSchema, epoch);
      const input = parse(
        z
          .object({
            expectedVersion: versionSchema,
            targetDates: z.object({ KRW: z.iso.date(), USD: z.iso.date() }).strict(),
            acknowledgement: z.literal('CARRY_FORWARD_PAPER_LOSSES'),
            observation: paperObservationSchema,
          })
          .strict(),
        value,
      );
      return locked(id, async (transaction, account) => {
        expected(account, input.expectedVersion);
        const now = await clock(transaction);
        owned(account, token, epoch, now);
        assertSource(account, 'toss-readonly');
        if (!account.stopped) throw new Error('PAPER_REVIEW_REQUIRES_STOP');
        for (const market of ['KR', 'US'] as const) {
          const currency = market === 'KR' ? 'KRW' : 'USD';
          if (input.targetDates[currency] !== marketTradingDate(now.getTime(), market))
            throw new Error('PAPER_REVIEW_EXPIRED');
        }
        const pending = await transaction
          .select({ id: paperIntents.intentId })
          .from(paperIntents)
          .where(and(eq(paperIntents.accountId, id), inArray(paperIntents.state, [...openStates])))
          .limit(1);
        if (pending.length) throw new Error('PAPER_RECOVERY_PENDING');
        const ledger = reviewPaperTradingDay(account.ledger, input.observation, now.toISOString());
        const updated = await advance(transaction, account, {
          ledger,
          epoch: account.epoch + 1,
          reason: 'DAILY_REVIEW_COMPLETED',
        });
        await event(transaction, id, 'DAILY_REVIEW_COMPLETED', {
          before: account.ledger.dailyPnl,
          after: ledger.dailyPnl,
          policy: 'carry-negative-pnl-v1',
        });
        owned(updated, token, updated.epoch, await clock(transaction));
      });
    },
    async observe(
      id: string,
      token: string,
      epoch: number,
      value: unknown,
      source: PaperDataSource = 'synthetic-only',
    ) {
      parse(paperExecutionSourceSchema, source);
      const observation = parse(paperObservationSchema, value);
      parse(z.uuid(), token);
      parse(versionSchema, epoch);
      return locked(id, async (transaction, account) => {
        assertSource(account, source);
        const now = await clock(transaction);
        owned(account, token, epoch, now);
        const ledger = observePaperLedger(account.ledger, observation, now.toISOString());
        const updated = await advance(transaction, account, { ledger });
        await event(transaction, id, 'ACCOUNT_OBSERVED', equityDetails(updated, now));
        const finalNow = await clock(transaction);
        owned(account, token, epoch, finalNow);
        if (finalNow.getTime() - now.getTime() >= 5000) throw new Error('PAPER_OBSERVATION_STALE');
        return updated.version;
      });
    },
    async abortOwned(id: string, intentId: string, token: string, epoch: number, reason: string) {
      const checked = parse(reasonSchema, reason);
      parse(z.uuid(), token);
      parse(versionSchema, epoch);
      return locked(id, async (transaction, account) => {
        owned(account, token, epoch, await clock(transaction));
        const intent = await abortLocked(transaction, account, await findIntent(transaction, id, intentId), checked);
        owned(account, token, epoch, await clock(transaction));
        return intent;
      });
    },
    async releaseLease(id: string, token: string, reason: string) {
      const checked = parse(reasonSchema, reason);
      parse(z.uuid(), token);
      return locked(id, async (transaction, account) => {
        if (account.leaseToken !== token) throw new Error('PAPER_LEASE_NOT_OWNED');
        await drain(transaction, account, checked);
        await advance(transaction, account, {
          stopped: true,
          epoch: account.epoch + 1,
          reason: account.stopped ? account.reason : checked,
          leaseToken: null,
          leaseUntil: null,
        });
        await event(transaction, id, 'LEASE_RELEASED', { reason: checked });
      });
    },
    async configureLimits(id: string, version: number, value: unknown) {
      const limits = checkLimits(value);
      return locked(id, async (transaction, account) => {
        expected(account, version);
        const updated = await advance(transaction, account, {
          limits,
          stopped: true,
          epoch: account.epoch + 1,
          reason: 'LIMITS_CHANGED',
        });
        await event(transaction, id, 'LIMITS_CHANGED', { epoch: updated.epoch });
        return updated.version;
      });
    },
    async configureStrategy(
      id: string,
      version: number,
      strategy: { id: string; version: string; enabled: boolean; definition?: PaperStrategyDefinition },
    ) {
      const config = parse(
        z
          .object({
            id: accountIdSchema,
            version: z.string().min(1).max(40),
            enabled: z.boolean(),
            definition: paperStrategyDefinitionSchema.optional(),
          })
          .strict(),
        strategy,
      );
      return locked(id, async (transaction, account) => {
        expected(account, version);
        const [previous] = await transaction
          .select()
          .from(paperStrategies)
          .where(and(eq(paperStrategies.accountId, id), eq(paperStrategies.strategyId, config.id)));
        const revision = (previous?.revision ?? 0) + 1;
        if (revision >= Number.MAX_SAFE_INTEGER - 1) throw new Error('PAPER_VERSION_EXHAUSTED');
        const definition = config.definition ?? previous?.definition ?? null;
        const definitionHash = contentHash({ version: config.version, definition });
        const change = { version: config.version, enabled: config.enabled, revision, definition, definitionHash };
        if (previous)
          await transaction
            .update(paperStrategies)
            .set(change)
            .where(and(eq(paperStrategies.accountId, id), eq(paperStrategies.strategyId, config.id)));
        else await transaction.insert(paperStrategies).values({ accountId: id, strategyId: config.id, ...change });
        await transaction.insert(paperStrategyRevisions).values({
          accountId: id,
          strategyId: config.id,
          revision,
          version: config.version,
          enabled: config.enabled,
          definition,
          actor: 'system',
          valueHash: contentHash({ revision, version: config.version, enabled: config.enabled, definition }),
        });
        const updated = await advance(transaction, account, {
          stopped: true,
          epoch: account.epoch + 1,
          reason: 'STRATEGY_CHANGED',
        });
        await event(transaction, id, 'STRATEGY_CHANGED', { epoch: updated.epoch });
        return updated.version;
      });
    },
    async updateStrategy(id: string, strategyId: string, value: unknown) {
      parse(accountIdSchema, strategyId);
      const input = parse(paperStrategyUpdateSchema, value);
      return locked(id, async (transaction, account) => {
        const [previous] = await transaction
          .select()
          .from(paperStrategies)
          .where(and(eq(paperStrategies.accountId, id), eq(paperStrategies.strategyId, strategyId)));
        if (!previous) throw new Error('PAPER_STRATEGY_NOT_FOUND');
        if (previous.revision !== input.expectedRevision) throw new Error('PAPER_STRATEGY_REVISION_CONFLICT');
        const revision = previous.revision + 1;
        if (revision >= Number.MAX_SAFE_INTEGER - 1) throw new Error('PAPER_VERSION_EXHAUSTED');
        const version = movingAverageCross.version;
        const definition = input.definition;
        const definitionHash = contentHash({ version, definition });
        await transaction
          .update(paperStrategies)
          .set({ version, enabled: input.enabled, revision, definition, definitionHash })
          .where(and(eq(paperStrategies.accountId, id), eq(paperStrategies.strategyId, strategyId)));
        await transaction.insert(paperStrategyRevisions).values({
          accountId: id,
          strategyId,
          revision,
          version,
          enabled: input.enabled,
          definition,
          actor: 'owner',
          valueHash: contentHash({ revision, version, enabled: input.enabled, definition }),
        });
        await advance(transaction, account, { stopped: true, epoch: account.epoch + 1, reason: 'STRATEGY_CHANGED' });
        await event(transaction, id, 'STRATEGY_CHANGED', { strategyId, revision, epoch: account.epoch + 1 });
        return { id: strategyId, version, enabled: input.enabled, revision, definition };
      });
    },
    async acquireLease(
      id: string,
      ttlMs = 30_000,
      source: PaperDataSource = 'synthetic-only',
      expectedVersion?: number,
    ) {
      parse(ttlSchema, ttlMs);
      return locked(id, async (transaction, account) => {
        assertSource(account, source);
        if (expectedVersion !== undefined) expected(account, expectedVersion);
        const now = await clock(transaction);
        if (account.leaseUntil && Date.parse(account.leaseUntil) > now.getTime()) throw new Error('PAPER_LEASE_BUSY');
        const token = randomUUID();
        const updated = await advance(transaction, account, {
          stopped: true,
          epoch: account.epoch + 1,
          reason: 'WORKER_RECOVERY_REQUIRED',
          ledger: { ...account.ledger, reconciled: false },
          leaseToken: token,
          leaseUntil: new Date(now.getTime() + ttlMs).toISOString(),
        });
        await event(transaction, id, 'LEASE_ACQUIRED', { epoch: updated.epoch });
        return { token, validUntil: updated.leaseUntil!, version: updated.version, epoch: updated.epoch };
      });
    },
    async renewLease(id: string, token: string, ttlMs = 30_000) {
      parse(ttlSchema, ttlMs);
      parse(z.uuid(), token);
      return locked(id, async (transaction, account) => {
        const now = await clock(transaction);
        if (!leaseOwned(account, token, now)) throw new Error('PAPER_LEASE_NOT_OWNED');
        const updated = await advance(transaction, account, {
          leaseUntil: new Date(now.getTime() + ttlMs).toISOString(),
        });
        return updated.leaseUntil!;
      });
    },
    async reconcile(id: string, token: string, version: number, value: unknown) {
      const marks = paperLedgerStateSchema.shape.positions.element.pick({
        instrument: true,
        markPrice: true,
        markTimestamp: true,
        markObservedAt: true,
      });
      const observation = parse(
        z
          .object({
            observedAt: z.iso.datetime({ offset: true }),
            marks: z.array(marks).max(10_000),
            dailyPnl: paperLedgerStateSchema.shape.dailyPnl,
            acknowledgement: z.literal('PAPER_RECONCILED'),
          })
          .strict(),
        value,
      );
      return locked(id, async (transaction, account) => {
        expected(account, version);
        const now = await clock(transaction);
        if (!leaseOwned(account, token, now)) throw new Error('PAPER_LEASE_NOT_OWNED');
        const pending = await transaction
          .select({ id: paperIntents.intentId })
          .from(paperIntents)
          .where(and(eq(paperIntents.accountId, id), inArray(paperIntents.state, [...openStates])))
          .limit(1);
        if (pending.length) throw new Error('PAPER_RECOVERY_PENDING');
        const key = (instrument: { market: string; symbol: string }) => `${instrument.market}:${instrument.symbol}`;
        const map = new Map(observation.marks.map((mark) => [key(mark.instrument), mark]));
        if (
          map.size !== observation.marks.length ||
          map.size !== account.ledger.positions.length ||
          account.ledger.positions.some((position) => !map.has(key(position.instrument)))
        )
          throw new Error('PAPER_MARKS_MISMATCH');
        if (
          Date.parse(observation.observedAt) > now.getTime() + 5000 ||
          now.getTime() - Date.parse(observation.observedAt) >= 60_000
        )
          throw new Error('PAPER_OBSERVATION_STALE');
        const ledger = {
          ...account.ledger,
          observedAt: observation.observedAt,
          reconciled: true,
          dailyPnl: observation.dailyPnl,
          positions: account.ledger.positions.map((position) => ({
            ...position,
            ...map.get(key(position.instrument))!,
          })),
        };
        const updated = await advance(transaction, account, { ledger });
        await event(transaction, id, 'ACCOUNT_RECONCILED', equityDetails(updated, now));
        return updated.version;
      });
    },
    async resume(id: string, token: string, version: number) {
      return locked(id, async (transaction, account) => {
        expected(account, version);
        const now = await clock(transaction);
        if (!leaseOwned(account, token, now)) throw new Error('PAPER_LEASE_NOT_OWNED');
        if (
          !account.ledger.reconciled ||
          !account.limits ||
          now.getTime() - Date.parse(account.ledger.observedAt) >= 60_000 ||
          Date.parse(account.ledger.observedAt) > now.getTime() + 5000
        )
          throw new Error('PAPER_RECOVERY_REQUIRED');
        checkLimits(account.limits);
        const active = await transaction
          .select({ id: paperIntents.intentId })
          .from(paperIntents)
          .where(and(eq(paperIntents.accountId, id), inArray(paperIntents.state, [...openStates])))
          .limit(1);
        if (active.length) throw new Error('PAPER_RECOVERY_PENDING');
        const updated = await advance(transaction, account, {
          stopped: false,
          epoch: account.epoch + 1,
          reason: 'EXPLICIT_PAPER_RESUME',
        });
        await event(transaction, id, 'PAPER_RESUMED', { epoch: updated.epoch });
        return updated.version;
      });
    },
    async stop(id: string, reason: string) {
      const validatedReason = parse(reasonSchema, reason);
      return locked(id, async (transaction, account) => {
        const updated = await advance(transaction, account, {
          stopped: true,
          epoch: account.epoch + 1,
          reason: validatedReason,
        });
        await event(transaction, id, 'PAPER_STOPPED', { epoch: updated.epoch });
        return updated.version;
      });
    },
    async recordIntent(value: unknown) {
      const input = parse(paperRecordedOrderSchema, value);
      const candidate = { ...input.candidate, limitPrice: normalizeDecimal(input.candidate.limitPrice) };
      const signal = { ...input.signal, barTimestamp: new Date(input.signal.barTimestamp).toISOString() };
      const { intentId, ...economics } = candidate;
      const dedupeKey = contentHash({
        strategyId: candidate.strategyId,
        instrument: candidate.instrument,
        side: candidate.side,
        strategyVersion: signal.strategyVersion,
        barTimestamp: signal.barTimestamp,
        interval: signal.interval,
        adjusted: signal.adjusted,
        source: signal.source,
      });
      const requestHash = contentHash({ candidate: economics, signal });
      const result = await locked(candidate.accountId, async (transaction, account) => {
        try {
          assertCandleSource(account, [signal.source]);
        } catch {
          await event(transaction, account.id, 'SOURCE_REJECTED', { code: 'PAPER_SOURCE_MISMATCH' });
          return { error: 'PAPER_SOURCE_MISMATCH' } as const;
        }
        const rows = await transaction
          .select()
          .from(paperIntents)
          .where(
            and(
              eq(paperIntents.accountId, account.id),
              or(eq(paperIntents.intentId, intentId), eq(paperIntents.dedupeKey, dedupeKey)),
            ),
          );
        if (rows.length) {
          if (rows.length !== 1 || rows[0]!.requestHash !== requestHash || rows[0]!.dedupeKey !== dedupeKey) {
            await event(transaction, account.id, 'INTENT_CONFLICT', {}, rows[0]!.intentId);
            return { error: 'PAPER_INTENT_CONFLICT' } as const;
          }
          return { intent: rows[0]!, replayed: true, executionEnabled: false as const };
        }
        const [intent] = await transaction
          .insert(paperIntents)
          .values({
            accountId: account.id,
            intentId,
            candidate,
            signal,
            dedupeKey,
            requestHash,
            recordedEpoch: account.epoch,
          })
          .returning();
        await advance(transaction, account);
        await event(transaction, account.id, 'INTENT_RECORDED', {}, intentId);
        return { intent: intent!, replayed: false, executionEnabled: false as const };
      });
      if ('error' in result) throw new Error(result.error);
      return result;
    },
    async reserve(id: string, intentId: string, token: string, value: unknown) {
      const evidence = parse(paperEvidenceSchema, value);
      parse(z.uuid(), token);
      const result = await locked(id, async (transaction, account) => {
        try {
          assertCandleSource(
            account,
            evidence.marketData.candles.map((candle) => candle.source),
          );
        } catch {
          await event(transaction, account.id, 'SOURCE_REJECTED', { code: 'PAPER_SOURCE_MISMATCH' });
          return { error: 'PAPER_SOURCE_MISMATCH' } as const;
        }
        const intent = await findIntent(transaction, id, intentId);
        const now = await clock(transaction);
        if (!leaseOwned(account, token, now)) {
          await event(transaction, id, 'LEASE_REJECTED', {}, intentId);
          return { error: 'PAPER_LEASE_NOT_OWNED' } as const;
        }
        if (intent.state !== 'INTENT_RECORDED') {
          if (
            (intent.state === 'READY' || intent.state === 'PARTIALLY_FILLED') &&
            (account.stopped ||
              intent.recordedEpoch !== account.epoch ||
              !intent.decision?.validUntil ||
              now.getTime() >= Date.parse(intent.decision.validUntil))
          )
            return {
              intent: await abortLocked(transaction, account, intent, 'STALE_RESERVATION'),
              replayed: true,
              executionEnabled: false as const,
            };
          return { intent, replayed: true, executionEnabled: false as const };
        }
        if (intent.recordedEpoch !== account.epoch)
          return {
            intent: await abortLocked(transaction, account, intent, 'CONTROL_CHANGED'),
            replayed: false,
            executionEnabled: false as const,
          };
        const [strategy] = await transaction
          .select()
          .from(paperStrategies)
          .where(and(eq(paperStrategies.accountId, id), eq(paperStrategies.strategyId, intent.candidate.strategyId)));
        const state = await snapshot(transaction, account);
        const control = {
          mode: 'paper' as const,
          stopped: account.stopped,
          epoch: account.epoch,
          reason: account.reason,
        };
        const runtime = {
          workerOwned: true,
          sourcesHealthy: evidence.sourcesHealthy,
          hasUnknownOrders: evidence.hasUnknownOrders,
          strategyEnabled: strategy?.enabled ?? false,
          dedupeClear: true,
        };
        const input = {
          candidate: intent.candidate,
          limits: account.limits,
          snapshot: state,
          control,
          runtime,
          quote: evidence.quote,
          marketData: evidence.marketData,
          asOf: now.toISOString(),
        };
        let decision = evaluatePaperRisk(input);
        if (decision.validUntil)
          decision.validUntil = new Date(
            Math.min(Date.parse(decision.validUntil), Date.parse(account.leaseUntil!)),
          ).toISOString();
        const prepared = prepareStrategyData({
          ...evidence.marketData,
          instrument: intent.candidate.instrument,
          quoteTimestamp: evidence.quote.timestamp,
          quoteObservedAt: evidence.quote.observedAt,
          accountObservedAt: state.observedAt,
          accountAvailable: state.reconciled,
          asOf: input.asOf,
        });
        const latest = prepared.candles.at(-1);
        const matches =
          strategy?.version === intent.signal.strategyVersion &&
          (!strategy.definition ||
            (intent.signal.configHash === strategy.definitionHash &&
              intent.signal.strategyRevision === strategy.revision &&
              strategy.definitionHash === contentHash({ version: strategy.version, definition: strategy.definition }) &&
              intent.candidate.instrument.market === strategy.definition.instrument.market &&
              intent.candidate.instrument.symbol === strategy.definition.instrument.symbol &&
              (intent.candidate.side === 'BUY'
                ? intent.candidate.quantity === strategy.definition.quantity
                : BigInt(intent.candidate.quantity) <= BigInt(strategy.definition.quantity)))) &&
          latest &&
          Date.parse(latest.timestamp) === Date.parse(intent.signal.barTimestamp) &&
          latest.interval === intent.signal.interval &&
          latest.adjusted === intent.signal.adjusted &&
          latest.source === intent.signal.source;
        if (!matches)
          decision = {
            ...decision,
            canReserve: false,
            validUntil: null,
            reservation: null,
            blockers: [...decision.blockers, 'SIGNAL_NOT_CURRENT'],
          };
        const codes = decision.blockers;
        if (!decision.canReserve || codes.length) {
          const [updated] = await transaction
            .update(paperIntents)
            .set({ state: 'RISK_REJECTED', version: intent.version + 1, decision, codes })
            .where(and(eq(paperIntents.accountId, id), eq(paperIntents.intentId, intentId)))
            .returning();
          await advance(transaction, account);
          await event(transaction, id, 'RISK_REJECTED', { codes }, intentId);
          return { intent: updated!, replayed: false, executionEnabled: false as const };
        }
        const reserve = decision.reservation!;
        const currency = intent.candidate.instrument.market === 'KR' ? 'KRW' : 'USD';
        await transaction.insert(paperReservations).values({
          accountId: id,
          intentId,
          quantity: reserve.quantity,
          valuationPrice: reserve.valuationPrice,
          cashAmount: reserve.cashAmount,
          sellQuantity: reserve.sellQuantity,
          costBps:
            intent.candidate.side === 'BUY'
              ? account.limits![currency].buyCostBps
              : account.limits![currency].sellCostBps,
          validUntil: decision.validUntil!,
        });
        const finalNow = await clock(transaction);
        const current =
          leaseOwned(account, token, finalNow) &&
          isPaperRiskCurrent(decision, {
            asOf: finalNow.toISOString(),
            control,
            snapshotVersion: state.version,
            candidate: intent.candidate,
            runtime,
          });
        if (!current) {
          await transaction
            .update(paperReservations)
            .set({ active: false })
            .where(and(eq(paperReservations.accountId, id), eq(paperReservations.intentId, intentId)));
          return {
            intent: await abortLocked(transaction, account, intent, 'EXPIRED_BEFORE_READY'),
            replayed: false,
            executionEnabled: false as const,
          };
        }
        const [updated] = await transaction
          .update(paperIntents)
          .set({ state: 'READY', version: intent.version + 1, decision, codes: [] })
          .where(and(eq(paperIntents.accountId, id), eq(paperIntents.intentId, intentId)))
          .returning();
        await advance(transaction, account);
        await event(
          transaction,
          id,
          'RESERVATION_CREATED',
          { epoch: account.epoch, snapshotVersion: state.version },
          intentId,
        );
        return { intent: updated!, replayed: false, executionEnabled: false as const };
      });
      if ('error' in result) throw new Error(result.error);
      return result;
    },
    async fill(id: string, intentId: string, token: string, request: unknown, value: unknown) {
      const input = parse(paperFillRequestSchema, request);
      const evidence = parse(paperEvidenceSchema, value);
      parse(z.uuid(), token);
      const requestHash = contentHash({ intentId, quantity: input.quantity, model: 'quote-proxy-v1' });
      const result = await locked(id, async (transaction, account) => {
        try {
          assertCandleSource(
            account,
            evidence.marketData.candles.map((candle) => candle.source),
          );
        } catch {
          await event(transaction, account.id, 'SOURCE_REJECTED', { code: 'PAPER_SOURCE_MISMATCH' });
          return { error: 'PAPER_SOURCE_MISMATCH' } as const;
        }
        const intent = await findIntent(transaction, id, intentId);
        const [previous] = await transaction
          .select()
          .from(paperFills)
          .where(and(eq(paperFills.accountId, id), eq(paperFills.fillId, input.fillId)));
        if (previous) {
          if (previous.requestHash !== requestHash) {
            await event(transaction, id, 'FILL_CONFLICT', {}, intentId);
            return { error: 'PAPER_FILL_CONFLICT' } as const;
          }
          return { fill: previous, replayed: true, executionEnabled: false as const };
        }
        const reject = async (code: string) => {
          await event(transaction, id, 'FILL_REJECTED', { code }, intentId);
          return { error: code };
        };
        const now = await clock(transaction);
        if (!leaseOwned(account, token, now)) return reject('PAPER_LEASE_NOT_OWNED');
        if (intent.state !== 'READY' && intent.state !== 'PARTIALLY_FILLED') return reject('PAPER_FILL_STATE_INVALID');
        if (
          account.stopped ||
          account.epoch !== intent.recordedEpoch ||
          !intent.decision?.validUntil ||
          now.getTime() >= Date.parse(intent.decision.validUntil)
        ) {
          await abortLocked(transaction, account, intent, 'STALE_RESERVATION');
          return { error: 'PAPER_RESERVATION_STALE' };
        }
        const [strategy] = await transaction
          .select()
          .from(paperStrategies)
          .where(and(eq(paperStrategies.accountId, id), eq(paperStrategies.strategyId, intent.candidate.strategyId)));
        if (!strategy?.enabled || strategy.version !== intent.signal.strategyVersion || !account.limits)
          return reject('PAPER_STRATEGY_DISABLED');
        if (
          strategy.definition &&
          (intent.signal.configHash !== strategy.definitionHash ||
            intent.signal.strategyRevision !== strategy.revision ||
            BigInt(input.quantity) > BigInt(strategy.definition.maxFillQuantity))
        )
          return reject('PAPER_STRATEGY_CONFIG_MISMATCH');
        const state = await snapshot(transaction, account);
        const prepared = prepareStrategyData({
          ...evidence.marketData,
          instrument: intent.candidate.instrument,
          quoteTimestamp: evidence.quote.timestamp,
          quoteObservedAt: evidence.quote.observedAt,
          accountObservedAt: state.observedAt,
          accountAvailable: state.reconciled,
          asOf: now.toISOString(),
        });
        const quote = evidence.quote;
        if (
          !prepared.ready ||
          !evidence.sourcesHealthy ||
          evidence.hasUnknownOrders ||
          !quote.timestamp ||
          quote.instrument.market !== intent.candidate.instrument.market ||
          quote.instrument.symbol !== intent.candidate.instrument.symbol ||
          !intent.decision.checkedAt ||
          Date.parse(quote.timestamp) < Date.parse(intent.decision.checkedAt) ||
          Date.parse(quote.observedAt) < Date.parse(intent.decision.checkedAt) ||
          state.positions.some(
            (position) =>
              position.instrument.market === intent.candidate.instrument.market &&
              [position.markTimestamp, position.markObservedAt].some(
                (instant) =>
                  instant === null ||
                  now.getTime() - Date.parse(instant) >= 120_000 ||
                  Date.parse(instant) > now.getTime() + 5000,
              ),
          )
        )
          return reject('PAPER_FILL_DATA_NOT_READY');
        const basisKey = {
          accountId: id,
          market: intent.candidate.instrument.market,
          symbol: intent.candidate.instrument.symbol,
          strategyId: intent.candidate.strategyId,
        };
        const [basis] = await transaction
          .select()
          .from(paperCostBasis)
          .where(
            and(
              eq(paperCostBasis.accountId, id),
              eq(paperCostBasis.market, basisKey.market),
              eq(paperCostBasis.symbol, basisKey.symbol),
              eq(paperCostBasis.strategyId, basisKey.strategyId),
            ),
          );
        const currency = basisKey.market === 'KR' ? 'KRW' : 'USD';
        let settled;
        try {
          settled = settlePaperFill({
            snapshot: state,
            candidate: intent.candidate,
            quantity: input.quantity,
            quote: { price: quote.price, timestamp: quote.timestamp, observedAt: quote.observedAt },
            cumulative: { quantity: intent.filledQuantity, notional: intent.filledNotional, costs: intent.paidCosts },
            basis: basis ?? null,
            asOf: now.toISOString(),
            maxDailyLoss: account.limits[currency].maxDailyLoss,
          });
        } catch (error) {
          return reject(
            error instanceof Error && /^PAPER_[A-Z_]+$/.test(error.message) ? error.message : 'PAPER_FILL_INVALID',
          );
        }
        if (!settled) {
          await event(transaction, id, 'LIMIT_NOT_REACHED', {}, intentId);
          return { fill: null, replayed: false, executionEnabled: false as const };
        }
        const [fill] = await transaction
          .insert(paperFills)
          .values({
            accountId: id,
            intentId,
            fillId: input.fillId,
            requestHash,
            quantity: settled.quantity,
            price: settled.price,
            notional: settled.notional,
            costs: settled.costs,
            realizedPnl: settled.realizedPnl,
            quoteTimestamp: quote.timestamp,
            quoteObservedAt: quote.observedAt,
            createdAt: now.toISOString(),
          })
          .returning();
        await transaction
          .insert(paperCostBasis)
          .values({ ...basisKey, ...settled.basis })
          .onConflictDoUpdate({
            target: [paperCostBasis.accountId, paperCostBasis.market, paperCostBasis.symbol, paperCostBasis.strategyId],
            set: settled.basis,
          });
        await transaction
          .update(paperIntents)
          .set({
            state: settled.remainingQuantity === '0' ? 'FILLED' : 'PARTIALLY_FILLED',
            version: intent.version + 1,
            filledQuantity: settled.filledQuantity,
            filledNotional: settled.filledNotional,
            paidCosts: settled.paidCosts,
          })
          .where(and(eq(paperIntents.accountId, id), eq(paperIntents.intentId, intentId)));
        await transaction
          .update(paperReservations)
          .set({
            active: settled.remainingQuantity !== '0',
            quantity: settled.remainingQuantity,
            cashAmount: settled.remainingCash,
            sellQuantity: settled.remainingSell,
          })
          .where(and(eq(paperReservations.accountId, id), eq(paperReservations.intentId, intentId)));
        const updated = await advance(transaction, account, { ledger: settled.ledger });
        await event(
          transaction,
          id,
          'PAPER_FILL_RECORDED',
          { fillId: input.fillId, ...equityDetails(updated, now) },
          intentId,
        );
        const finalNow = await clock(transaction);
        if (
          !leaseOwned(account, token, finalNow) ||
          finalNow.getTime() >= Date.parse(intent.decision.validUntil) ||
          finalNow.getTime() >= Date.parse(prepared.validUntil!)
        )
          throw new Error('PAPER_FILL_EXPIRED');
        return { fill: fill!, replayed: false, executionEnabled: false as const };
      });
      if ('error' in result) throw new Error(result.error);
      return result;
    },
    async readFills(id: string, intentId: string) {
      return locked(id, async (transaction) => {
        await findIntent(transaction, id, intentId);
        return transaction
          .select()
          .from(paperFills)
          .where(and(eq(paperFills.accountId, id), eq(paperFills.intentId, intentId)));
      });
    },
    async abort(id: string, intentId: string, reason: string) {
      const validatedReason = parse(reasonSchema, reason);
      return locked(id, async (transaction, account) => ({
        intent: await abortLocked(transaction, account, await findIntent(transaction, id, intentId), validatedReason),
        executionEnabled: false as const,
      }));
    },
    async readIntent(id: string, intentId: string) {
      return locked(id, (transaction) => findIntent(transaction, id, intentId));
    },
    async readOpenIntents(id: string) {
      return locked(id, (transaction) =>
        transaction
          .select()
          .from(paperIntents)
          .where(and(eq(paperIntents.accountId, id), inArray(paperIntents.state, [...openStates]))),
      );
    },
  };
}
