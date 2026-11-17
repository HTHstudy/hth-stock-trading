import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import {
  orderObservationSchema,
  syntheticLedgerInitializationSchema,
  syntheticLedgerStateSchema,
  syntheticLedgerEffectSchema,
} from '@hth/contracts';
import {
  initializeSyntheticLedger,
  registerSyntheticLedgerOrder,
  applySyntheticLedgerObservation,
  syntheticLedgerStateIssue,
} from '@hth/trading';
import type { createDatabase } from './index.js';
import { contentHash, normalizeDecimal } from './content-hash.js';
import { createSyntheticOrderBindingStore, withSyntheticBindingState } from './synthetic-order-binding.js';
import {
  syntheticLedgerAccounts as accounts,
  syntheticLedgerOrders as orders,
  syntheticLedgerObservations as observations,
  syntheticLedgerMutations as mutations,
} from './schema.js';
const uuid = z.uuid().transform((v) => v.toLowerCase()),
  hash = z.string().regex(/^[a-f0-9]{64}$/),
  version = z.number().int().min(0).max(544),
  source = z.literal('synthetic-fixture');
const keys = { source, accountId: uuid, bindingId: uuid };
const cas = { expectedVersion: version, expectedStateHash: hash };
const registrationFields = {
  bindingId: uuid,
  baseline: orderObservationSchema,
  reservedCash: z.string().max(30),
  reservedQuantity: z.string().max(20),
};
const registrationSchema = z.strictObject({ ...registrationFields, bindingHash: hash, intentHash: hash });
const registerSchema = z.strictObject({
  ...keys,
  ...cas,
  baseline: orderObservationSchema,
  reservedCash: z
    .string()
    .regex(/^\d+(?:\.\d+)?$/)
    .max(30),
  reservedQuantity: z.string().regex(/^\d+$/).max(20),
});
const observeSchema = z.strictObject({
  ...keys,
  sequence: z.number().int().min(1).max(512),
  observation: orderObservationSchema,
});
const applySchema = z.strictObject({
  ...keys,
  ...cas,
  sequence: z.number().int().min(1).max(512),
  expectedObservationHash: hash,
});
const safety = {
  ledgerApplied: false,
  ownershipVerified: false,
  evidenceAuthenticated: false,
  canApplyToLedger: false,
  executionEnabled: false,
  canResend: false,
  canResume: false,
} as const;
const receiptSchema = z.strictObject({
  formatVersion: z.literal('synthetic-ledger-mutation-v1'),
  kind: z.enum(['register', 'apply']),
  bindingId: uuid,
  sequence: z.number().int().min(1).max(512).nullable(),
  version,
  beforeHash: hash,
  afterHash: hash,
  inputHash: hash,
  effect: syntheticLedgerEffectSchema.nullable(),
  receiptHash: hash,
  ledgerApplied: z.literal(false),
  ownershipVerified: z.literal(false),
  evidenceAuthenticated: z.literal(false),
  canApplyToLedger: z.literal(false),
  executionEnabled: z.literal(false),
  canResend: z.literal(false),
  canResume: z.literal(false),
});
function parse<T>(schema: z.ZodType<T>, input: unknown, code = 'SYNTHETIC_LEDGER_INPUT_INVALID'): T {
  const p = schema.safeParse(input);
  if (!p.success) throw new Error(code);
  return JSON.parse(JSON.stringify(p.data)) as T;
}
function integrity(): never {
  throw new Error('SYNTHETIC_LEDGER_INTEGRITY_FAILED');
}
/** Separate synthetic projection only. Real/Paper accounts and execution gates are never modified. */
export function createSyntheticLedgerStore(database: ReturnType<typeof createDatabase>, connectionString: string) {
  createSyntheticOrderBindingStore(database, connectionString);
  type Tx = Parameters<Parameters<ReturnType<typeof createDatabase>['db']['transaction']>[0]>[0];
  const withState = <T>(id: string, fn: Parameters<typeof withSyntheticBindingState<T>>[3]) =>
    withSyntheticBindingState(database, connectionString, id, fn);
  async function load(tx: Tx, id: string, registry: Parameters<Parameters<typeof withSyntheticBindingState>[3]>[1]) {
    const [row] = await tx.select().from(accounts).where(eq(accounts.accountId, id)).for('update');
    if (!row) throw new Error('SYNTHETIC_LEDGER_MISSING');
    const state = parse(syntheticLedgerStateSchema, row.state, 'SYNTHETIC_LEDGER_INTEGRITY_FAILED'),
      initial = parse(syntheticLedgerStateSchema, row.initial, 'SYNTHETIC_LEDGER_INTEGRITY_FAILED');
    if (
      row.stateHash !== contentHash(state) ||
      row.initialHash !== contentHash(initial) ||
      row.version !== state.version ||
      state.namespace.accountId !== id ||
      initial.version !== 0 ||
      initial.orders.length !== 0 ||
      initial.positions.some((p) => p.owners.length > 0) ||
      syntheticLedgerStateIssue(state) ||
      syntheticLedgerStateIssue(initial)
    )
      integrity();
    if (
      contentHash(state.namespace) !==
        contentHash({
          accountId: registry.account.accountId,
          brokerId: registry.account.brokerId,
          environment: registry.account.environment,
        }) ||
      state.scope !== registry.account.scope ||
      contentHash(initial.namespace) !== contentHash(state.namespace) ||
      initial.scope !== state.scope ||
      Object.values(initial.receivables).some((v) => v !== '0') ||
      Object.values(initial.realizedPnl).some((v) => v !== '0')
    )
      integrity();
    const orderRows = await tx.select().from(orders).where(eq(orders.accountId, id)).limit(33);
    const obsRows = await tx
      .select()
      .from(observations)
      .where(eq(observations.accountId, id))
      .orderBy(observations.bindingId, observations.sequence)
      .limit(513);
    const mutationRows = await tx
      .select()
      .from(mutations)
      .where(eq(mutations.accountId, id))
      .orderBy(mutations.version)
      .limit(545);
    if (
      orderRows.length !== state.orders.length ||
      orderRows.length > 32 ||
      obsRows.length > 512 ||
      mutationRows.length !== state.version
    )
      integrity();
    const parsedOrders = orderRows.map((o) => {
      const registration = parse(registrationSchema, o.registration, 'SYNTHETIC_LEDGER_INTEGRITY_FAILED');
      const projected = state.orders.find((p) => p.binding.bindingId === o.bindingId);
      const linked = registry.bindings.find((b) => b.bindingId === o.bindingId);
      if (
        !linked ||
        linked.payloadHash !== registration.bindingHash ||
        linked.intentHash !== registration.intentHash ||
        !projected ||
        contentHash(projected.binding) !== linked.payloadHash
      )
        integrity();
      const samples = obsRows.filter((s) => s.bindingId === o.bindingId);
      if (
        !projected ||
        registration.bindingId !== o.bindingId ||
        o.registrationHash !== contentHash(registration) ||
        samples.length !== o.observedCount
      )
        integrity();
      for (const [index, sample] of samples.entries()) {
        const observed = parse(orderObservationSchema, sample.observation, 'SYNTHETIC_LEDGER_INTEGRITY_FAILED');
        if (sample.sequence !== index + 1 || sample.observationHash !== contentHash(observed)) integrity();
      }
      const last = samples.at(-1)?.observationHash ?? contentHash(registration.baseline);
      if (last !== o.observedHash) integrity();
      return { ...o, registration };
    });
    let previous = row.initialHash;
    const registered = new Set<string>(),
      applied = new Map<string, number>();
    const parsedMutations = mutationRows.map((m, index) => {
      const receipt = parse(receiptSchema, m.receipt, 'SYNTHETIC_LEDGER_INTEGRITY_FAILED');
      const { receiptHash, ...body } = receipt;
      if (
        m.version !== index + 1 ||
        receipt.version !== m.version ||
        receiptHash !== contentHash(body) ||
        receiptHash !== m.receiptHash ||
        receipt.beforeHash !== previous ||
        receipt.beforeHash !== m.beforeHash ||
        receipt.afterHash !== m.afterHash ||
        receipt.bindingId !== m.bindingId ||
        receipt.kind !== m.kind ||
        receipt.sequence !== m.sequence
      )
        integrity();
      const order = parsedOrders.find((o) => o.bindingId === m.bindingId);
      if (!order) integrity();
      if (m.kind === 'register') {
        if (
          registered.has(m.bindingId) ||
          m.sequence !== null ||
          order.createdVersion !== m.version ||
          receipt.inputHash !== order.registrationHash ||
          receipt.effect !== null
        )
          integrity();
        registered.add(m.bindingId);
        applied.set(m.bindingId, 0);
      } else {
        const count = applied.get(m.bindingId),
          sample = obsRows.find((o) => o.bindingId === m.bindingId && o.sequence === m.sequence);
        if (
          count === undefined ||
          m.sequence !== count + 1 ||
          !sample ||
          receipt.inputHash !== sample.observationHash ||
          receipt.effect?.bindingId !== m.bindingId ||
          receipt.effect.sequence !== m.sequence
        )
          integrity();
        applied.set(m.bindingId, m.sequence!);
      }
      previous = m.afterHash;
      return { ...m, receipt };
    });
    if (previous !== row.stateHash || registered.size !== state.orders.length) integrity();
    for (const o of state.orders) {
      if (applied.get(o.binding.bindingId) !== o.sequence) integrity();
      const expected =
        o.sequence === 0
          ? parsedOrders.find((r) => r.bindingId === o.binding.bindingId)?.registration.baseline
          : obsRows.find((r) => r.bindingId === o.binding.bindingId && r.sequence === o.sequence)?.observation;
      if (!expected || contentHash(o.observation) !== contentHash(expected)) integrity();
    }
    return { row, state, initial, orders: parsedOrders, observations: obsRows, mutations: parsedMutations };
  }
  async function save(
    tx: Tx,
    current: Awaited<ReturnType<typeof load>>,
    state: z.infer<typeof syntheticLedgerStateSchema>,
    kind: 'register' | 'apply',
    bindingId: string,
    sequence: number | null,
    inputHash: string,
    effect: z.infer<typeof syntheticLedgerEffectSchema> | null,
  ) {
    const afterHash = contentHash(state),
      body = {
        formatVersion: 'synthetic-ledger-mutation-v1' as const,
        kind,
        bindingId,
        sequence,
        version: state.version,
        beforeHash: current.row.stateHash,
        afterHash,
        inputHash,
        effect,
        ...safety,
      };
    const receipt = parse(receiptSchema, { ...body, receiptHash: contentHash(body) });
    await tx.insert(mutations).values({
      accountId: state.namespace.accountId,
      version: state.version,
      bindingId,
      sequence,
      kind,
      beforeHash: body.beforeHash,
      afterHash,
      receipt,
      receiptHash: receipt.receiptHash,
    });
    const changed = await tx
      .update(accounts)
      .set({ state, stateHash: afterHash, version: state.version })
      .where(
        and(
          eq(accounts.accountId, state.namespace.accountId),
          eq(accounts.version, current.state.version),
          eq(accounts.stateHash, current.row.stateHash),
        ),
      )
      .returning({ id: accounts.accountId });
    if (changed.length !== 1) throw new Error('SYNTHETIC_LEDGER_CONFLICT');
    return { outcome: 'stored' as const, replayed: false, receipt };
  }
  return {
    async initialize(input: unknown) {
      const parsed = parse(syntheticLedgerInitializationSchema, input),
        projection = initializeSyntheticLedger(parsed);
      if (!projection.state) throw new Error('SYNTHETIC_LEDGER_CONFLICT');
      const state = projection.state,
        initialHash = contentHash(state);
      return withState(parsed.namespace.accountId, async (tx, registry) => {
        if (
          contentHash(parsed.namespace) !==
            contentHash({
              accountId: registry.account.accountId,
              brokerId: registry.account.brokerId,
              environment: registry.account.environment,
            }) ||
          parsed.scope !== registry.account.scope
        )
          throw new Error('SYNTHETIC_LEDGER_BINDING_INVALID');
        await tx
          .insert(accounts)
          .values({
            accountId: parsed.namespace.accountId,
            initial: state,
            initialHash,
            state,
            stateHash: initialHash,
            version: 0,
          })
          .onConflictDoNothing();
        const current = await load(tx, parsed.namespace.accountId, registry);
        if (current.row.initialHash !== initialHash) throw new Error('SYNTHETIC_LEDGER_CONFLICT');
        return { state: current.state, stateHash: current.row.stateHash, ...safety };
      });
    },
    async read(accountId: unknown) {
      const id = parse(uuid, accountId);
      return withState(id, async (tx, registry) => {
        const current = await load(tx, id, registry);
        return { state: current.state, stateHash: current.row.stateHash, ...safety };
      });
    },
    async register(input: unknown) {
      const c = parse(registerSchema, input);
      return withState(c.accountId, async (tx, registry) => {
        const current = await load(tx, c.accountId, registry),
          binding = registry.bindings.find((b) => b.bindingId === c.bindingId);
        if (
          !binding ||
          binding.evidence.observation.state !== 'pending' ||
          normalizeDecimal(binding.evidence.observation.execution.quantity) !== '0'
        )
          throw new Error('SYNTHETIC_LEDGER_BINDING_INVALID');
        const registration = {
            bindingId: c.bindingId,
            baseline: c.baseline,
            reservedCash: c.reservedCash,
            reservedQuantity: c.reservedQuantity,
            bindingHash: binding.payloadHash,
            intentHash: binding.intentHash,
          },
          inputHash = contentHash(registration);
        const old = current.orders.find((o) => o.bindingId === c.bindingId);
        if (old) {
          if (old.registrationHash !== inputHash) throw new Error('SYNTHETIC_LEDGER_CONFLICT');
          return {
            outcome: 'stored' as const,
            replayed: true,
            receipt: current.mutations.find((m) => m.version === old.createdVersion)!.receipt,
          };
        }
        if (current.state.version !== c.expectedVersion || current.row.stateHash !== c.expectedStateHash)
          throw new Error('SYNTHETIC_LEDGER_CONFLICT');
        const intent = registry.intents.find((i) => i.intentId === binding.intentId)!;
        const result = registerSyntheticLedgerOrder({
          source: c.source,
          state: current.state,
          proof: {
            ...binding.evidence,
            observation: c.baseline,
            intent: intent.payload,
            registry: { complete: true, bindings: registry.bindings.map((b) => b.payload) },
          },
          reservedCash: c.reservedCash,
          reservedQuantity: c.reservedQuantity,
        });
        if (!result.state) return { outcome: 'blocked' as const, reason: result.reason, ...safety };
        await tx.insert(orders).values({
          accountId: c.accountId,
          bindingId: c.bindingId,
          registration,
          registrationHash: inputHash,
          createdVersion: result.state.version,
          observedCount: 0,
          observedHash: contentHash(c.baseline),
        });
        return save(tx, current, result.state, 'register', c.bindingId, null, inputHash, null);
      });
    },
    async observe(input: unknown) {
      const c = parse(observeSchema, input),
        observedHash = contentHash(c.observation);
      return withState(c.accountId, async (tx, registry) => {
        const current = await load(tx, c.accountId, registry),
          order = current.orders.find((o) => o.bindingId === c.bindingId);
        if (!order) throw new Error('SYNTHETIC_LEDGER_BINDING_INVALID');
        const old = current.observations.find((o) => o.bindingId === c.bindingId && o.sequence === c.sequence);
        if (old) {
          if (old.observationHash !== observedHash) throw new Error('SYNTHETIC_LEDGER_CONFLICT');
          return { replayed: true, observationHash: old.observationHash, ...safety };
        }
        if (current.observations.length >= 512) throw new Error('SYNTHETIC_LEDGER_LIMIT');
        if (c.sequence !== order.observedCount + 1) throw new Error('SYNTHETIC_LEDGER_CONFLICT');
        await tx.insert(observations).values({
          accountId: c.accountId,
          bindingId: c.bindingId,
          sequence: c.sequence,
          observation: c.observation,
          observationHash: observedHash,
        });
        const changed = await tx
          .update(orders)
          .set({ observedCount: c.sequence, observedHash })
          .where(
            and(
              eq(orders.bindingId, c.bindingId),
              eq(orders.observedCount, order.observedCount),
              eq(orders.observedHash, order.observedHash),
            ),
          )
          .returning({ id: orders.bindingId });
        if (changed.length !== 1) throw new Error('SYNTHETIC_LEDGER_CONFLICT');
        return { replayed: false, observationHash: observedHash, ...safety };
      });
    },
    async apply(input: unknown) {
      const c = parse(applySchema, input);
      return withState(c.accountId, async (tx, registry) => {
        const current = await load(tx, c.accountId, registry),
          sample = current.observations.find((o) => o.bindingId === c.bindingId && o.sequence === c.sequence);
        if (!sample || sample.observationHash !== c.expectedObservationHash)
          throw new Error('SYNTHETIC_LEDGER_CONFLICT');
        const old = current.mutations.find(
          (m) => m.kind === 'apply' && m.bindingId === c.bindingId && m.sequence === c.sequence,
        );
        if (old) return { outcome: 'stored' as const, replayed: true, receipt: old.receipt };
        if (current.state.version !== c.expectedVersion || current.row.stateHash !== c.expectedStateHash)
          throw new Error('SYNTHETIC_LEDGER_CONFLICT');
        const result = applySyntheticLedgerObservation({
          source: c.source,
          state: current.state,
          bindingId: c.bindingId,
          sequence: c.sequence,
          observation: sample.observation,
        });
        if (!result.state) return { outcome: 'blocked' as const, reason: result.reason, ...safety };
        return save(tx, current, result.state, 'apply', c.bindingId, c.sequence, sample.observationHash, result.effect);
      });
    },
  };
}
