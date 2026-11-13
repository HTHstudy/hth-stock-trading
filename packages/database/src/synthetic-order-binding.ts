import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { syntheticOrderBindingInputSchema, syntheticOrderBindingReviewSchema } from '@hth/contracts';
import { reviewSyntheticOrderBinding } from '@hth/trading';
import type { createDatabase } from './index.js';
import { contentHash } from './content-hash.js';
import { dedicatedPaperDatabaseUrl } from './local-compose.js';
import {
  syntheticBindingAccounts as accounts,
  syntheticBindingIntents as intents,
  syntheticOrderBindings as bindings,
  syntheticBindingEvents as events,
} from './schema.js';

const uuid = z.uuid().transform((v) => v.toLowerCase()),
  hash = z.string().regex(/^[a-f0-9]{64}$/);
const version = z.number().int().min(0).max(512);
const inputSchema = syntheticOrderBindingInputSchema;
const intentSchema = inputSchema.shape.intent.unwrap(),
  bindingSchema = inputSchema.shape.candidate.unwrap();
const evidenceSchema = inputSchema.omit({ intent: true, registry: true });
const initializeSchema = z.strictObject({
  source: z.literal('synthetic-fixture'),
  namespace: inputSchema.shape.context.shape.namespace,
  scope: hash,
});
const seedSchema = z.strictObject({
  source: z.literal('synthetic-fixture'),
  expectedVersion: version,
  expectedStateHash: hash,
  intent: intentSchema,
});
const commandSchema = z.strictObject({
  source: z.literal('synthetic-fixture'),
  operationId: uuid,
  expectedVersion: version,
  expectedStateHash: hash,
  evidence: evidenceSchema,
});
const accountSchema = z.strictObject({
  accountId: uuid,
  brokerId: z.string(),
  environment: z.literal('synthetic-fixture'),
  scope: hash,
  version,
  intentCount: z.number().int().min(0).max(256),
  bindingCount: z.number().int().min(0).max(256),
  eventCount: z.number().int().min(0).max(512),
  lastReceiptHash: hash.nullable(),
  stateHash: hash,
});
const safety = {
  evidenceAuthenticated: false,
  financialBaselineEstablished: false,
  ledgerApplied: false,
  canApplyToLedger: false,
  ownershipVerified: false,
  executionEnabled: false,
  canResend: false,
  canResume: false,
} as const;
const receiptSchema = z.strictObject({
  formatVersion: z.literal('synthetic-order-binding-receipt-v1'),
  operationId: uuid,
  sequence: z.number().int().min(1).max(512),
  requestHash: hash,
  previousReceiptHash: hash.nullable(),
  receiptHash: hash,
  versionBefore: version,
  versionAfter: version,
  outcome: z.enum(['bound', 'unchanged', 'unassigned', 'blocked', 'conflict']),
  bindingId: uuid.nullable(),
  evidenceHash: hash,
  review: syntheticOrderBindingReviewSchema.nullable(),
  evidenceAuthenticated: z.literal(false),
  financialBaselineEstablished: z.literal(false),
  ledgerApplied: z.literal(false),
  canApplyToLedger: z.literal(false),
  ownershipVerified: z.literal(false),
  executionEnabled: z.literal(false),
  canResend: z.literal(false),
  canResume: z.literal(false),
});
function parse<T>(schema: z.ZodType<T>, input: unknown, code = 'ORDER_BINDING_INPUT_INVALID'): T {
  const p = schema.safeParse(input);
  if (!p.success) throw new Error(code);
  // Public JSON contracts treat an explicit undefined optional value as an absent JSON key.
  return JSON.parse(JSON.stringify(p.data)) as T;
}
const namespace = (account: z.infer<typeof accountSchema>) => ({
  brokerId: account.brokerId,
  environment: account.environment,
  accountId: account.accountId,
});
const fail = () => {
  throw new Error('ORDER_BINDING_INTEGRITY_FAILED');
};

/** Dedicated synthetic identity registry. No default database/worker/HTTP wiring or financial writes. */
export function createSyntheticOrderBindingStore(
  database: ReturnType<typeof createDatabase>,
  connectionString: string,
) {
  try {
    if (
      new URL(dedicatedPaperDatabaseUrl(connectionString)).href !==
      new URL(dedicatedPaperDatabaseUrl(database.db.$client.options.connectionString)).href
    )
      throw new Error('MISMATCH');
  } catch {
    throw new Error('ORDER_BINDING_DATABASE_INVALID');
  }
  const db = database.db;
  type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
  const transaction = <T>(fn: (tx: Tx) => Promise<T>) =>
    db
      .transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
        await tx.execute(sql`SET LOCAL lock_timeout = '3s'`);
        const result = await tx.execute<{ name: string; role: string }>(
          sql`SELECT current_database() AS name,current_user AS role`,
        );
        if (result.rows[0]?.name !== 'hth_readonly_test' || result.rows[0]?.role !== 'hth_test')
          throw new Error('ORDER_BINDING_DATABASE_INVALID');
        return fn(tx);
      })
      .catch((error: unknown) => {
        const allowed = new Set([
          'ORDER_BINDING_DATABASE_INVALID',
          'ORDER_BINDING_MISSING',
          'ORDER_BINDING_INTEGRITY_FAILED',
          'ORDER_BINDING_ACCOUNT_CONFLICT',
          'ORDER_BINDING_INTENT_CONFLICT',
          'ORDER_BINDING_SIGNAL_EXISTS',
          'ORDER_BINDING_VERSION_CONFLICT',
          'ORDER_BINDING_LIMIT',
          'ORDER_BINDING_OPERATION_REUSED',
          'ORDER_BINDING_REVIEW_REQUIRED',
        ]);
        throw new Error(
          error instanceof Error && allowed.has(error.message) ? error.message : 'ORDER_BINDING_TRANSACTION_FAILED',
        );
      });
  async function update(tx: Tx, before: z.infer<typeof accountSchema>, next: z.infer<typeof accountSchema>) {
    const state = accountSchema.omit({ stateHash: true }).strip().parse(next);
    const rows = await tx
      .update(accounts)
      .set({ ...state, stateHash: contentHash(state) })
      .where(
        and(
          eq(accounts.accountId, before.accountId),
          eq(accounts.version, before.version),
          eq(accounts.stateHash, before.stateHash),
        ),
      )
      .returning({ id: accounts.accountId });
    if (rows.length !== 1) throw new Error('ORDER_BINDING_VERSION_CONFLICT');
  }
  async function load(tx: Tx, id: string) {
    const [raw] = await tx.select().from(accounts).where(eq(accounts.accountId, id)).for('update');
    if (!raw) throw new Error('ORDER_BINDING_MISSING');
    const account = parse(accountSchema, raw, 'ORDER_BINDING_INTEGRITY_FAILED');
    const { stateHash, ...state } = account;
    if (stateHash !== contentHash(state) || account.version !== account.intentCount + account.bindingCount) fail();
    const intentRows = await tx.select().from(intents).where(eq(intents.accountId, id)).limit(257);
    const bindingRows = await tx.select().from(bindings).where(eq(bindings.accountId, id)).limit(257);
    const eventRows = await tx
      .select()
      .from(events)
      .where(eq(events.accountId, id))
      .orderBy(events.sequence)
      .limit(513);
    if (
      intentRows.length !== account.intentCount ||
      bindingRows.length !== account.bindingCount ||
      eventRows.length !== account.eventCount
    )
      fail();
    const versions = new Set<number>(),
      intentVersions = new Set<number>();
    const parsedIntents = intentRows.map((row) => {
      const payload = parse(intentSchema, row.payload, 'ORDER_BINDING_INTEGRITY_FAILED');
      if (
        row.payloadHash !== contentHash(payload) ||
        row.intentId !== payload.intentId ||
        row.dedupeKey !== payload.dedupeKey ||
        contentHash(payload.namespace) !== contentHash(namespace(account)) ||
        versions.has(row.createdVersion)
      )
        fail();
      versions.add(row.createdVersion);
      intentVersions.add(row.createdVersion);
      return { ...row, payload };
    });
    const parsedBindings = bindingRows.map((row) => {
      const payload = parse(bindingSchema, row.payload, 'ORDER_BINDING_INTEGRITY_FAILED');
      const evidence = parse(evidenceSchema, row.evidence, 'ORDER_BINDING_INTEGRITY_FAILED');
      const parent = parsedIntents.find((i) => i.intentId === row.intentId);
      if (
        !parent ||
        parent.payloadHash !== row.intentHash ||
        parent.payload.dedupeKey !== payload.dedupeKey ||
        parent.payload.requestHash !== payload.requestHash ||
        contentHash(parent.payload.strategy) !== contentHash(payload.strategy) ||
        row.payloadHash !== contentHash(payload) ||
        row.evidenceHash !== contentHash(evidence) ||
        contentHash(evidence.candidate) !== row.payloadHash ||
        payload.bindingId !== row.bindingId ||
        payload.intentId !== row.intentId ||
        payload.dedupeKey !== row.dedupeKey ||
        payload.orderReference !== row.orderReference ||
        contentHash(payload.namespace) !== contentHash(namespace(account)) ||
        contentHash(evidence.context.namespace) !== contentHash(namespace(account)) ||
        evidence.context.scope !== account.scope ||
        versions.has(row.createdVersion) ||
        parent.createdVersion >= row.createdVersion
      )
        fail();
      versions.add(row.createdVersion);
      return { ...row, payload, evidence };
    });
    if (
      versions.size !== account.version ||
      Array.from({ length: account.version }, (_, i) => i + 1).some((v) => !versions.has(v))
    )
      fail();
    let previous: string | null = null,
      lastVersion = 0;
    const consumed = new Set<string>();
    const parsedEvents = eventRows.map((row, index) => {
      const request = parse(commandSchema, row.request, 'ORDER_BINDING_INTEGRITY_FAILED');
      const receipt = parse(receiptSchema, row.receipt, 'ORDER_BINDING_INTEGRITY_FAILED');
      const { receiptHash, ...payload } = receipt;
      if (
        receiptHash !== contentHash(payload) ||
        receiptHash !== row.receiptHash ||
        receipt.requestHash !== row.requestHash ||
        row.requestHash !== contentHash(request) ||
        receipt.operationId !== row.operationId ||
        request.operationId !== row.operationId ||
        receipt.sequence !== index + 1 ||
        row.sequence !== index + 1 ||
        receipt.previousReceiptHash !== previous ||
        receipt.bindingId !== row.bindingId ||
        receipt.evidenceHash !== contentHash(request.evidence) ||
        contentHash(request.evidence.context.namespace) !== contentHash(namespace(account)) ||
        request.evidence.context.scope !== account.scope ||
        receipt.versionBefore < lastVersion ||
        receipt.versionAfter > account.version
      )
        fail();
      for (let v = lastVersion + 1; v <= receipt.versionBefore; v++) if (!intentVersions.has(v)) fail();
      if (receipt.versionAfter !== receipt.versionBefore + (receipt.outcome === 'bound' ? 1 : 0)) fail();
      const prefix = {
        ...state,
        version: receipt.versionBefore,
        intentCount: parsedIntents.filter((i) => i.createdVersion <= receipt.versionBefore).length,
        bindingCount: parsedBindings.filter((b) => b.createdVersion <= receipt.versionBefore).length,
        eventCount: index,
        lastReceiptHash: previous,
      };
      const matched =
        request.expectedVersion === receipt.versionBefore && request.expectedStateHash === contentHash(prefix);
      if ((receipt.outcome === 'conflict') === matched) fail();
      if (
        ['bound', 'unchanged'].includes(receipt.outcome) &&
        receipt.bindingId !== request.evidence.candidate?.bindingId
      )
        fail();
      if (receipt.outcome === 'bound') {
        const binding = parsedBindings.find((b) => b.bindingId === receipt.bindingId);
        if (
          !binding ||
          binding.operationId !== row.operationId ||
          binding.createdVersion !== receipt.versionAfter ||
          binding.evidenceHash !== receipt.evidenceHash ||
          consumed.has(binding.bindingId) ||
          receipt.review?.outcome !== 'consistent-synthetic-binding'
        )
          fail();
        consumed.add(binding!.bindingId);
      } else if (receipt.outcome === 'unchanged') {
        if (
          !parsedBindings.some((b) => b.bindingId === receipt.bindingId && b.createdVersion <= receipt.versionBefore) ||
          receipt.review?.outcome !== 'unchanged-synthetic-binding'
        )
          fail();
      } else if (
        receipt.bindingId !== null ||
        (receipt.outcome === 'conflict' ? receipt.review !== null : receipt.review?.outcome !== receipt.outcome)
      )
        fail();
      previous = receiptHash;
      lastVersion = receipt.versionAfter;
      return { request, receipt };
    });
    for (let v = lastVersion + 1; v <= account.version; v++) if (!intentVersions.has(v)) fail();
    if (previous !== account.lastReceiptHash || consumed.size !== bindingRows.length) fail();
    return { account, intents: parsedIntents, bindings: parsedBindings, events: parsedEvents };
  }
  type Snapshot = Awaited<ReturnType<typeof load>>;
  const stateView = (s: Snapshot) => ({
    ...s.account,
    registry: { complete: true as const, bindings: s.bindings.map((b) => b.payload) },
    ...safety,
  });
  return {
    async initialize(input: unknown) {
      const c = parse(initializeSchema, input);
      const state = {
        accountId: c.namespace.accountId,
        brokerId: c.namespace.brokerId,
        environment: c.namespace.environment,
        scope: c.scope,
        version: 0,
        intentCount: 0,
        bindingCount: 0,
        eventCount: 0,
        lastReceiptHash: null,
      };
      return transaction(async (tx) => {
        await tx
          .insert(accounts)
          .values({ ...state, stateHash: contentHash(state) })
          .onConflictDoNothing();
        const current = await load(tx, c.namespace.accountId);
        if (contentHash(namespace(current.account)) !== contentHash(c.namespace) || current.account.scope !== c.scope)
          throw new Error('ORDER_BINDING_ACCOUNT_CONFLICT');
        return stateView(current);
      });
    },
    async read(accountId: unknown) {
      const id = parse(uuid, accountId);
      return transaction(async (tx) => stateView(await load(tx, id)));
    },
    async recordIntent(input: unknown) {
      const c = parse(seedSchema, input),
        payloadHash = contentHash(c.intent);
      return transaction(async (tx) => {
        const current = await load(tx, c.intent.namespace.accountId),
          a = current.account;
        if (contentHash(namespace(a)) !== contentHash(c.intent.namespace))
          throw new Error('ORDER_BINDING_ACCOUNT_CONFLICT');
        const old = current.intents.find((i) => i.intentId === c.intent.intentId);
        if (old) {
          if (old.payloadHash !== payloadHash) throw new Error('ORDER_BINDING_INTENT_CONFLICT');
          return { replayed: true, intentHash: payloadHash, ...safety };
        }
        if (
          current.events.some(
            (e) => e.receipt.outcome === 'unassigned' && e.request.evidence.candidate?.intentId === c.intent.intentId,
          )
        )
          throw new Error('ORDER_BINDING_REVIEW_REQUIRED');
        if (current.intents.some((i) => i.dedupeKey === c.intent.dedupeKey))
          throw new Error('ORDER_BINDING_SIGNAL_EXISTS');
        if (a.version !== c.expectedVersion || a.stateHash !== c.expectedStateHash)
          throw new Error('ORDER_BINDING_VERSION_CONFLICT');
        if (a.intentCount >= 256) throw new Error('ORDER_BINDING_LIMIT');
        await tx.insert(intents).values({
          accountId: a.accountId,
          intentId: c.intent.intentId,
          dedupeKey: c.intent.dedupeKey,
          payload: c.intent,
          payloadHash,
          createdVersion: a.version + 1,
        });
        await update(tx, a, { ...a, version: a.version + 1, intentCount: a.intentCount + 1 });
        return { replayed: false, intentHash: payloadHash, ...safety };
      });
    },
    async record(input: unknown) {
      const c = parse(commandSchema, input),
        requestHash = contentHash(c),
        evidenceHash = contentHash(c.evidence);
      return transaction(async (tx) => {
        const current = await load(tx, c.evidence.context.namespace.accountId),
          a = current.account;
        if (
          contentHash(namespace(a)) !== contentHash(c.evidence.context.namespace) ||
          a.scope !== c.evidence.context.scope
        )
          throw new Error('ORDER_BINDING_ACCOUNT_CONFLICT');
        const old = current.events.find((e) => e.request.operationId === c.operationId);
        if (old) {
          if (old.receipt.requestHash !== requestHash) throw new Error('ORDER_BINDING_OPERATION_REUSED');
          return { replayed: true, receipt: old.receipt };
        }
        if (a.eventCount >= 512) throw new Error('ORDER_BINDING_LIMIT');
        let outcome: z.infer<typeof receiptSchema>['outcome'] = 'conflict',
          review: z.infer<typeof syntheticOrderBindingReviewSchema> | null = null;
        let bindingId: string | null = null,
          next = a;
        if (a.version === c.expectedVersion && a.stateHash === c.expectedStateHash) {
          if (
            current.events.some(
              (e) =>
                e.receipt.outcome === 'unassigned' &&
                (e.request.evidence.observation.orderReference === c.evidence.observation.orderReference ||
                  (c.evidence.candidate !== null &&
                    e.request.evidence.candidate?.intentId === c.evidence.candidate.intentId)),
            )
          )
            throw new Error('ORDER_BINDING_REVIEW_REQUIRED');
          const intent = current.intents.find((i) => i.intentId === c.evidence.candidate?.intentId);
          review = reviewSyntheticOrderBinding({
            ...c.evidence,
            intent: intent?.payload ?? null,
            registry: { complete: true, bindings: current.bindings.map((b) => b.payload) },
          });
          if (review.outcome === 'consistent-synthetic-binding') {
            if (!c.evidence.candidate || !intent || a.bindingCount >= 256) throw new Error('ORDER_BINDING_LIMIT');
            const b = c.evidence.candidate;
            await tx.insert(bindings).values({
              bindingId: b.bindingId,
              accountId: a.accountId,
              intentId: b.intentId,
              intentHash: intent.payloadHash,
              dedupeKey: b.dedupeKey,
              orderReference: b.orderReference,
              payload: b,
              payloadHash: contentHash(b),
              evidence: c.evidence,
              evidenceHash,
              createdVersion: a.version + 1,
              operationId: c.operationId,
            });
            outcome = 'bound';
            bindingId = b.bindingId;
            next = { ...a, version: a.version + 1, bindingCount: a.bindingCount + 1 };
          } else if (review.outcome === 'unchanged-synthetic-binding') {
            outcome = 'unchanged';
            bindingId = c.evidence.candidate!.bindingId;
          } else outcome = review.outcome;
        }
        const payload = {
          formatVersion: 'synthetic-order-binding-receipt-v1' as const,
          operationId: c.operationId,
          sequence: a.eventCount + 1,
          requestHash,
          previousReceiptHash: a.lastReceiptHash,
          versionBefore: a.version,
          versionAfter: next.version,
          outcome,
          bindingId,
          evidenceHash,
          review,
          ...safety,
        };
        const receipt = parse(receiptSchema, { ...payload, receiptHash: contentHash(payload) });
        await tx.insert(events).values({
          accountId: a.accountId,
          operationId: c.operationId,
          sequence: receipt.sequence,
          bindingId,
          request: c,
          requestHash,
          receipt,
          receiptHash: receipt.receiptHash,
        });
        await update(tx, a, { ...next, eventCount: a.eventCount + 1, lastReceiptHash: receipt.receiptHash });
        return { replayed: false, receipt };
      });
    },
  };
}
