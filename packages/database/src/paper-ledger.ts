import { randomUUID } from 'node:crypto';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import {
  paperEvidenceSchema,
  paperFillRequestSchema,
  paperLedgerStateSchema,
  paperOrderCandidateSchema,
  paperRecordedOrderSchema,
  paperRiskLimitsSchema,
  paperRiskSnapshotSchema,
} from '@hth/contracts';
import type { PaperLedgerState, PaperRiskSnapshot } from '@hth/contracts';
import { evaluatePaperRisk, isPaperRiskCurrent, prepareStrategyData, settlePaperFill } from '@hth/trading';
import type * as schema from './schema.js';
import {
  paperAccounts,
  paperEvents,
  paperIntents,
  paperReservations,
  paperStrategies,
  paperFills,
  paperCostBasis,
} from './schema.js';
import { contentHash, normalizeDecimal } from './content-hash.js';

type Database = NodePgDatabase<typeof schema>;
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type Account = typeof paperAccounts.$inferSelect;
type Intent = typeof paperIntents.$inferSelect;
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

export function createPaperLedger(db: Database) {
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
  return {
    async createAccount(id: string, value: unknown) {
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
            .values({ id, ledger })
            .onConflictDoNothing()
            .returning();
          if (created) await event(transaction, id, 'ACCOUNT_CREATED');
          return { created: Boolean(created), executionEnabled: false as const };
        }),
      );
    },
    async readAccount(id: string) {
      return locked(id, async (transaction, account) => ({
        control: { mode: 'paper' as const, stopped: account.stopped, epoch: account.epoch, reason: account.reason },
        limits: account.limits,
        snapshot: await snapshot(transaction, account),
        leaseUntil: account.leaseUntil,
      }));
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
    async configureStrategy(id: string, version: number, strategy: { id: string; version: string; enabled: boolean }) {
      const config = parse(
        z.object({ id: accountIdSchema, version: z.string().min(1).max(40), enabled: z.boolean() }).strict(),
        strategy,
      );
      return locked(id, async (transaction, account) => {
        expected(account, version);
        await transaction
          .insert(paperStrategies)
          .values({ accountId: id, strategyId: config.id, version: config.version, enabled: config.enabled })
          .onConflictDoUpdate({
            target: [paperStrategies.accountId, paperStrategies.strategyId],
            set: { version: config.version, enabled: config.enabled },
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
    async acquireLease(id: string, ttlMs = 30_000) {
      parse(ttlSchema, ttlMs);
      return locked(id, async (transaction, account) => {
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
        return { token, validUntil: updated.leaseUntil!, version: updated.version };
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
        await event(transaction, id, 'ACCOUNT_RECONCILED');
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
        ...signal,
      });
      const requestHash = contentHash({ candidate: economics, signal });
      const result = await locked(candidate.accountId, async (transaction, account) => {
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
        await advance(transaction, account, { ledger: settled.ledger });
        await event(transaction, id, 'PAPER_FILL_RECORDED', { fillId: input.fillId }, intentId);
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
