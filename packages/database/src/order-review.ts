import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { orderObservationSchema, orderReconciliationReportSchema } from '@hth/contracts';
import { reconcileOrderObservations } from '@hth/trading';
import type { createDatabase } from './index.js';
import { orderReviewStreams, orderReviewEvents } from './schema.js';
import { contentHash } from './content-hash.js';
import { dedicatedPaperDatabaseUrl } from './local-compose.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const version = z.number().int().min(0).max(2147483646);
const safety = {
  ledgerApplied: false,
  canApplyToLedger: false,
  ownershipVerified: false,
  executionEnabled: false,
  canResend: false,
  canResume: false,
} as const;
const initializeSchema = z.strictObject({
  id: z.uuid(),
  source: z.literal('synthetic-fixture'),
  observation: orderObservationSchema,
});
const requestSchema = z.strictObject({
  streamId: z.uuid(),
  operationId: z.uuid(),
  source: z.literal('synthetic-fixture'),
  expectedVersion: version,
  expectedObservationHash: hash,
  observation: orderObservationSchema,
});
const receiptSchema = z.strictObject({
  formatVersion: z.literal('synthetic-order-review-receipt-v1'),
  streamId: z.uuid(),
  operationId: z.uuid(),
  requestHash: hash,
  outcome: z.enum(['checkpoint-advanced', 'unchanged', 'review-held', 'held', 'conflict']),
  versionBefore: version,
  versionAfter: version,
  baselineHashBefore: hash,
  baselineHashAfter: hash,
  observedHash: hash,
  report: orderReconciliationReportSchema.nullable(),
  receiptHash: hash,
  sequence: z.number().int().min(1).max(512),
  previousReceiptHash: hash.nullable(),
  ledgerApplied: z.literal(false),
  canApplyToLedger: z.literal(false),
  ownershipVerified: z.literal(false),
  executionEnabled: z.literal(false),
  canResend: z.literal(false),
  canResume: z.literal(false),
});
const streamSchema = z.object({
  id: z.uuid(),
  source: z.literal('synthetic-fixture'),
  scope: hash,
  referenceHash: hash,
  initialObservation: orderObservationSchema,
  initialObservationHash: hash,
  version,
  status: z.enum(['ready', 'quarantined']),
  observation: orderObservationSchema,
  observationHash: hash,
  stateHash: hash,
  eventCount: z.number().int().min(0).max(512),
  lastReceiptHash: hash.nullable(),
});
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const p = schema.safeParse(input);
  if (!p.success) throw new Error('ORDER_REVIEW_INPUT_INVALID');
  return p.data;
}
function verifiedStream(raw: unknown) {
  const p = streamSchema.safeParse(raw);
  if (!p.success) throw new Error('ORDER_REVIEW_INTEGRITY_FAILED');
  const { stateHash, ...state } = p.data;
  if (
    contentHash(state) !== stateHash ||
    contentHash(state.initialObservation) !== state.initialObservationHash ||
    contentHash(state.observation) !== state.observationHash ||
    state.observation.scope !== state.scope ||
    state.initialObservation.scope !== state.scope ||
    contentHash(state.observation.orderReference) !== state.referenceHash ||
    contentHash(state.initialObservation.orderReference) !== state.referenceHash
  )
    throw new Error('ORDER_REVIEW_INTEGRITY_FAILED');
  return p.data;
}
/** Explicit testing capability; never attached to the default application database service. */
export function createSyntheticOrderReviewStore(database: ReturnType<typeof createDatabase>, connectionString: string) {
  try {
    const target = dedicatedPaperDatabaseUrl(connectionString);
    const actual = dedicatedPaperDatabaseUrl(database.db.$client.options.connectionString);
    if (new URL(target).href !== new URL(actual).href) throw new Error('MISMATCH');
  } catch {
    throw new Error('ORDER_REVIEW_DATABASE_INVALID');
  }
  const db = database.db;
  type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
  const transaction = <T>(operation: (tx: Tx) => Promise<T>) =>
    db
      .transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
        await tx.execute(sql`SET LOCAL lock_timeout = '3s'`);
        const identity = await tx.execute<{ name: string; role: string }>(
          sql`SELECT current_database() AS name,current_user AS role`,
        );
        if (identity.rows[0]?.name !== 'hth_readonly_test' || identity.rows[0]?.role !== 'hth_test')
          throw new Error('ORDER_REVIEW_DATABASE_INVALID');
        return operation(tx);
      })
      .catch((error: unknown) => {
        const allowed = new Set([
          'ORDER_REVIEW_DATABASE_INVALID',
          'ORDER_REVIEW_STREAM_MISSING',
          'ORDER_REVIEW_INTEGRITY_FAILED',
          'ORDER_REVIEW_BINDING_EXISTS',
          'ORDER_REVIEW_STREAM_EXISTS',
          'ORDER_REVIEW_OPERATION_REUSED',
          'ORDER_REVIEW_VERSION_EXHAUSTED',
          'ORDER_REVIEW_CAS_FAILED',
          'ORDER_REVIEW_EVENT_LIMIT',
        ]);
        throw new Error(
          error instanceof Error && allowed.has(error.message) ? error.message : 'ORDER_REVIEW_TRANSACTION_FAILED',
        );
      });
  const read = async (tx: Tx, id: string, lock: boolean) => {
    const query = tx.select().from(orderReviewStreams).where(eq(orderReviewStreams.id, id));
    const rows = await (lock ? query.for('update') : query);
    if (!rows[0]) throw new Error('ORDER_REVIEW_STREAM_MISSING');
    return verifiedStream(rows[0]);
  };
  async function history(tx: Tx, current: z.infer<typeof streamSchema>) {
    const rows = await tx
      .select()
      .from(orderReviewEvents)
      .where(eq(orderReviewEvents.streamId, current.id))
      .orderBy(orderReviewEvents.sequence)
      .limit(513);
    if (rows.length !== current.eventCount || rows.length > 512) throw new Error('ORDER_REVIEW_INTEGRITY_FAILED');
    let previousHash: string | null = null,
      baselineHash = current.initialObservationHash,
      checkpointVersion = 0,
      held = false;
    const verified: { request: z.infer<typeof requestSchema>; receipt: z.infer<typeof receiptSchema> }[] = [];
    for (const [i, row] of rows.entries()) {
      const parsedReceipt = receiptSchema.safeParse(row.receipt),
        parsedRequest = requestSchema.safeParse(row.request);
      if (!parsedReceipt.success || !parsedRequest.success) throw new Error('ORDER_REVIEW_INTEGRITY_FAILED');
      const receipt = parsedReceipt.data,
        request = parsedRequest.data,
        { receiptHash, ...payload } = receipt;
      if (
        receiptHash !== row.receiptHash ||
        contentHash(payload) !== receiptHash ||
        contentHash(request) !== row.requestHash ||
        receipt.requestHash !== row.requestHash ||
        receipt.streamId !== current.id ||
        request.streamId !== current.id ||
        receipt.operationId !== row.operationId ||
        request.operationId !== row.operationId ||
        receipt.observedHash !== contentHash(request.observation) ||
        receipt.sequence !== i + 1 ||
        row.sequence !== i + 1 ||
        receipt.previousReceiptHash !== previousHash ||
        receipt.versionBefore !== checkpointVersion ||
        receipt.baselineHashBefore !== baselineHash ||
        (held && !['held', 'conflict'].includes(receipt.outcome))
      )
        throw new Error('ORDER_REVIEW_INTEGRITY_FAILED');
      const advanced = receipt.outcome === 'checkpoint-advanced',
        quarantined = receipt.outcome === 'review-held';
      if (
        receipt.versionAfter !== checkpointVersion + (advanced || quarantined ? 1 : 0) ||
        receipt.baselineHashAfter !== (advanced ? receipt.observedHash : baselineHash)
      )
        throw new Error('ORDER_REVIEW_INTEGRITY_FAILED');
      held ||= quarantined;
      checkpointVersion = receipt.versionAfter;
      baselineHash = receipt.baselineHashAfter;
      previousHash = receiptHash;
      verified.push({ request, receipt });
    }
    if (
      previousHash !== current.lastReceiptHash ||
      checkpointVersion !== current.version ||
      baselineHash !== current.observationHash ||
      held !== (current.status === 'quarantined')
    )
      throw new Error('ORDER_REVIEW_INTEGRITY_FAILED');
    return verified;
  }
  return {
    async initialize(input: unknown) {
      const command = parse(initializeSchema, input),
        o = command.observation;
      const zero = (value: string | null) => value !== null && /^0+(\.0+)?$/.test(value);
      if (
        o.state !== 'pending' ||
        !zero(o.execution.quantity) ||
        !zero(o.execution.amount) ||
        !zero(o.execution.commission) ||
        !zero(o.execution.tax) ||
        o.execution.averagePrice !== null ||
        o.execution.lastFilledAt !== null ||
        o.execution.settlementDate !== null ||
        o.canceledAt != null ||
        reconcileOrderObservations(o, o).outcome !== 'unchanged'
      )
        throw new Error('ORDER_REVIEW_BASELINE_INVALID');
      const initialHash = contentHash(o);
      const state = {
        id: command.id,
        source: command.source,
        scope: o.scope,
        referenceHash: contentHash(o.orderReference),
        initialObservation: o,
        initialObservationHash: initialHash,
        version: 0,
        status: 'ready' as const,
        observation: o,
        observationHash: initialHash,
        eventCount: 0,
        lastReceiptHash: null,
      };
      return transaction(async (tx) => {
        await tx
          .insert(orderReviewStreams)
          .values({ ...state, stateHash: contentHash(state) })
          .onConflictDoNothing();
        const [row] = await tx
          .select()
          .from(orderReviewStreams)
          .where(eq(orderReviewStreams.id, command.id))
          .for('update');
        if (!row) throw new Error('ORDER_REVIEW_BINDING_EXISTS');
        const current = verifiedStream(row);
        await history(tx, current);
        if (current.initialObservationHash !== initialHash) throw new Error('ORDER_REVIEW_STREAM_EXISTS');
        return { ...current, ...safety };
      });
    },
    async read(streamId: unknown) {
      const id = parse(z.uuid(), streamId);
      return transaction(async (tx) => {
        const current = await read(tx, id, true);
        await history(tx, current);
        return { ...current, ...safety };
      });
    },
    async record(input: unknown) {
      const command = parse(requestSchema, input),
        requestHash = contentHash(command),
        observedHash = contentHash(command.observation);
      return transaction(async (tx) => {
        const current = await read(tx, command.streamId, true);
        const verified = await history(tx, current);
        const old = verified.find((event) => event.receipt.operationId === command.operationId);
        if (old) {
          if (contentHash(old.request) !== requestHash) throw new Error('ORDER_REVIEW_OPERATION_REUSED');
          return { replayed: true, receipt: old.receipt };
        }
        if (current.eventCount >= 512) throw new Error('ORDER_REVIEW_EVENT_LIMIT');
        let outcome: z.infer<typeof receiptSchema>['outcome'];
        let report: ReturnType<typeof reconcileOrderObservations> | null = null;
        let next = current;
        if (command.expectedVersion !== current.version || command.expectedObservationHash !== current.observationHash)
          outcome = 'conflict';
        else if (current.status === 'quarantined') outcome = 'held';
        else {
          report = reconcileOrderObservations(current.observation, command.observation);
          if (['blocked', 'review-required', 'baseline-required'].includes(report.outcome)) {
            outcome = 'review-held';
            next = { ...current, status: 'quarantined', version: current.version + 1 };
          } else if (observedHash === current.observationHash) outcome = 'unchanged';
          else {
            outcome = 'checkpoint-advanced';
            next = {
              ...current,
              version: current.version + 1,
              observation: command.observation,
              observationHash: observedHash,
            };
          }
        }
        if (next.version > 2147483646) throw new Error('ORDER_REVIEW_VERSION_EXHAUSTED');
        const payload = {
          formatVersion: 'synthetic-order-review-receipt-v1' as const,
          streamId: command.streamId,
          operationId: command.operationId,
          requestHash,
          outcome,
          versionBefore: current.version,
          versionAfter: next.version,
          baselineHashBefore: current.observationHash,
          baselineHashAfter: next.observationHash,
          observedHash,
          sequence: current.eventCount + 1,
          previousReceiptHash: current.lastReceiptHash,
          report,
          ...safety,
        };
        const receipt = parse(receiptSchema, { ...payload, receiptHash: contentHash(payload) });
        next = { ...next, eventCount: current.eventCount + 1, lastReceiptHash: receipt.receiptHash };
        {
          const state = streamSchema.omit({ stateHash: true }).parse(next);
          const changed = await tx
            .update(orderReviewStreams)
            .set({ ...state, stateHash: contentHash(state) })
            .where(
              and(
                eq(orderReviewStreams.id, current.id),
                eq(orderReviewStreams.version, current.version),
                eq(orderReviewStreams.stateHash, current.stateHash),
              ),
            )
            .returning({ id: orderReviewStreams.id });
          if (changed.length !== 1) throw new Error('ORDER_REVIEW_CAS_FAILED');
        }
        await tx.insert(orderReviewEvents).values({
          streamId: command.streamId,
          operationId: command.operationId,
          request: command,
          requestHash,
          receipt,
          receiptHash: receipt.receiptHash,
          sequence: receipt.sequence,
        });
        return { replayed: false, receipt };
      });
    },
  };
}
