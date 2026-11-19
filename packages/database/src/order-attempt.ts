import { z } from 'zod';
import { asc, eq, sql } from 'drizzle-orm';
import { orderAttemptContextSchema, orderAttemptCommandSchema, storedOrderAttemptEventSchema } from '@hth/contracts';
import type { StoredOrderAttemptEvent } from '@hth/contracts';
import { evolveOrderAttempt, initialOrderAttemptState } from '@hth/trading';
import type { createDatabase } from './index.js';
import { contentHash } from './content-hash.js';
import { dedicatedPaperDatabaseUrl } from './local-compose.js';
import { orderAttemptAccounts as accounts, orderAttemptEvents as events } from './schema.js';
const safety = {
  executionEnabled: false,
  ownershipVerified: false,
  canApplyToLedger: false,
  canResend: false,
  canResume: false,
} as const;
const uuid = z.uuid().transform((v) => v.toLowerCase());
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const p = schema.safeParse(input);
  if (!p.success) throw new Error('ORDER_ATTEMPT_INPUT_INVALID');
  return p.data;
}
function fail(): never {
  throw new Error('ORDER_ATTEMPT_INTEGRITY_FAILED');
}
function keys(data: StoredOrderAttemptEvent['data']) {
  return {
    kind: data.kind,
    intentKey: data.kind === 'intent' ? data.intent.intentId : null,
    clientKey: data.kind === 'intent' ? data.intent.request.clientOrderId : null,
    signalKey: data.kind === 'intent' ? data.intent.signalId : null,
    attemptKey: data.kind === 'attempt' ? data.attemptId : null,
    claimedIntent: data.kind === 'attempt' ? data.intentId : null,
    resolvedAttempt: data.kind === 'result' ? data.attemptId : null,
  };
}
/** Dedicated mock-wire journal only; not added to createDatabase/default apps or production exports. */
export function createOrderAttemptTestStore(database: ReturnType<typeof createDatabase>, connectionString: string) {
  try {
    if (
      new URL(dedicatedPaperDatabaseUrl(connectionString)).href !==
      new URL(dedicatedPaperDatabaseUrl(database.db.$client.options.connectionString)).href
    )
      throw new Error('MISMATCH');
  } catch {
    throw new Error('ORDER_ATTEMPT_DATABASE_INVALID');
  }
  const db = database.db;
  type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
  async function transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    try {
      return await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
        await tx.execute(sql`SET LOCAL lock_timeout = '3s'`);
        const actual = await tx.execute<{ name: string; role: string }>(
          sql`SELECT current_database() AS name,current_user AS role`,
        );
        if (actual.rows[0]?.name !== 'hth_readonly_test' || actual.rows[0]?.role !== 'hth_test')
          throw new Error('ORDER_ATTEMPT_DATABASE_INVALID');
        return fn(tx);
      });
    } catch (error) {
      const allowed = [
        'DATABASE_INVALID',
        'INPUT_INVALID',
        'INTEGRITY_FAILED',
        'MISSING',
        'CONTEXT_CONFLICT',
        'OPERATION_CONFLICT',
        'STALE',
        'CLOCK_REGRESSION',
        'LIMIT',
        'LEASE_BUSY',
        'FENCED',
        'INTENT_CONFLICT',
        'INTENT_EXPIRED',
        'INTENT_MISMATCH',
        'ALREADY_CLAIMED',
        'REVIEW_REQUIRED',
        'RESULT_CONFLICT',
        'FILL_UNBOUND',
        'FILL_MISMATCH',
        'FILL_REVIEW_REQUIRED',
        'FILL_SEQUENCE',
      ].map((v) => `ORDER_ATTEMPT_${v}`);
      if (error instanceof Error && allowed.includes(error.message)) throw new Error(error.message);
      throw new Error('ORDER_ATTEMPT_DATABASE_FAILED');
    }
  }
  async function load(tx: Tx, accountId: string) {
    const [account] = await tx.select().from(accounts).where(eq(accounts.accountId, accountId)).for('update');
    if (!account) throw new Error('ORDER_ATTEMPT_MISSING');
    const ctx = orderAttemptContextSchema.safeParse(account.context);
    if (!ctx.success || ctx.data.accountId !== accountId || contentHash(ctx.data) !== account.contextHash) fail();
    const rows = await tx
      .select()
      .from(events)
      .where(eq(events.accountId, accountId))
      .orderBy(asc(events.sequence))
      .limit(513);
    if (rows.length !== account.version || rows.length > 512) fail();
    let state = initialOrderAttemptState(),
      head = account.contextHash,
      lastTime = -Infinity;
    const journal: StoredOrderAttemptEvent[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const p = storedOrderAttemptEventSchema.safeParse(row.event);
      if (!p.success) fail();
      const event = p.data,
        { eventHash, ...body } = event;
      if (
        event.sequence !== journal.length + 1 ||
        event.previousHash !== head ||
        contentHash(body) !== eventHash ||
        contentHash({
          operationId: event.operationId,
          expectedVersion: event.sequence - 1,
          expectedStateHash: event.previousHash,
          data: event.data,
        }) !== event.commandHash ||
        row.eventHash !== eventHash ||
        row.operationId !== event.operationId ||
        seen.has(event.operationId) ||
        Date.parse(event.at) < lastTime
      )
        fail();
      const expectedKeys = keys(event.data);
      for (const k of Object.keys(expectedKeys) as (keyof typeof expectedKeys)[])
        if (row[k] !== expectedKeys[k]) fail();
      try {
        state = evolveOrderAttempt(
          state,
          event.data,
          event.at,
          event.data.kind === 'intent' ? contentHash(event.data.intent) : null,
          ctx.data.scopeHash,
        );
      } catch {
        fail();
      }
      seen.add(event.operationId);
      journal.push(event);
      head = eventHash;
      lastTime = Date.parse(event.at);
    }
    if (head !== account.headHash) fail();
    return { context: ctx.data, version: account.version, stateHash: head, state, journal, ...safety };
  }
  return {
    async initialize(input: unknown) {
      const context = parse(orderAttemptContextSchema, input),
        hash = contentHash(context);
      return transaction(async (tx) => {
        await tx
          .insert(accounts)
          .values({ accountId: context.accountId, context, contextHash: hash, version: 0, headHash: hash })
          .onConflictDoNothing();
        const snapshot = await load(tx, context.accountId);
        if (contentHash(snapshot.context) !== hash) throw new Error('ORDER_ATTEMPT_CONTEXT_CONFLICT');
        return snapshot;
      });
    },
    async read(raw: unknown) {
      const accountId = parse(uuid, raw);
      return transaction((tx) => load(tx, accountId));
    },
    async record(rawAccountId: unknown, input: unknown) {
      const accountId = parse(uuid, rawAccountId),
        command = parse(orderAttemptCommandSchema, input);
      const commandHash = contentHash(command);
      return transaction(async (tx) => {
        const before = await load(tx, accountId);
        const previous = before.journal.find((v) => v.operationId === command.operationId);
        if (previous) {
          if (previous.commandHash !== commandHash) throw new Error('ORDER_ATTEMPT_OPERATION_CONFLICT');
          return { snapshot: before, event: previous, replayed: true, mockDispatchClaimed: false, ...safety };
        }
        if (command.expectedVersion !== before.version || command.expectedStateHash !== before.stateHash)
          throw new Error('ORDER_ATTEMPT_STALE');
        if (before.version >= 512) throw new Error('ORDER_ATTEMPT_LIMIT');
        const time = await tx.execute<{ milliseconds: string }>(
          sql`SELECT (extract(epoch from clock_timestamp()) * 1000)::bigint::text AS milliseconds`,
        );
        const milliseconds = time.rows[0]?.milliseconds;
        if (!milliseconds || !/^\d{1,15}$/.test(milliseconds)) fail();
        const at = new Date(Number(milliseconds)).toISOString();
        if (!at || !z.iso.datetime().safeParse(at).success) fail();
        const last = before.journal.at(-1);
        if (last && Date.parse(at) < Date.parse(last.at)) throw new Error('ORDER_ATTEMPT_CLOCK_REGRESSION');
        evolveOrderAttempt(
          before.state,
          command.data,
          at,
          command.data.kind === 'intent' ? contentHash(command.data.intent) : null,
          before.context.scopeHash,
        );
        const body = {
          operationId: command.operationId,
          sequence: before.version + 1,
          commandHash,
          previousHash: before.stateHash,
          at,
          data: command.data,
        };
        const event = { ...body, eventHash: contentHash(body) };
        await tx.insert(events).values({
          accountId,
          sequence: event.sequence,
          operationId: event.operationId,
          ...keys(event.data),
          event,
          eventHash: event.eventHash,
        });
        await tx
          .update(accounts)
          .set({ version: event.sequence, headHash: event.eventHash })
          .where(eq(accounts.accountId, accountId));
        return {
          snapshot: await load(tx, accountId),
          event,
          replayed: false,
          mockDispatchClaimed: command.data.kind === 'attempt',
          ...safety,
        };
      });
    },
  };
}
