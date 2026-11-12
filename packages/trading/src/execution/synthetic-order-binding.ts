import { Decimal } from 'decimal.js';
import { syntheticOrderBindingInputSchema } from '@hth/contracts';
import type { SyntheticOrderBindingInput, SyntheticOrderBindingReview } from '@hth/contracts';

const Money = Decimal.clone({ precision: 100 });
type Binding = NonNullable<SyntheticOrderBindingInput['candidate']>;
type Namespace = Binding['namespace'];
type Reason = SyntheticOrderBindingReview['reasons'][number];
const namespaceKey = (n: Namespace) => JSON.stringify([n.brokerId, n.environment, n.accountId]);
const sameStrategy = (a: Binding['strategy'], b: Binding['strategy']) =>
  a.id === b.id && a.revision === b.revision && a.definitionHash === b.definitionHash;
const sameBinding = (a: Binding, b: Binding) =>
  a.bindingId === b.bindingId &&
  namespaceKey(a.namespace) === namespaceKey(b.namespace) &&
  a.intentId === b.intentId &&
  sameStrategy(a.strategy, b.strategy) &&
  a.requestHash === b.requestHash &&
  a.dedupeKey === b.dedupeKey &&
  a.orderReference === b.orderReference;
const equalMoney = (a: string | null | undefined, b: string | null | undefined) =>
  a == null || b == null ? a === b : new Money(a).eq(b);

/** Checks relationships between synthetic assertions. Never authenticates, persists or authorizes them. */
export function reviewSyntheticOrderBinding(input: unknown): SyntheticOrderBindingReview {
  const finish = (outcome: SyntheticOrderBindingReview['outcome'], reasons: Reason[]): SyntheticOrderBindingReview => ({
    formatVersion: 'synthetic-order-binding-review-v1',
    outcome,
    reasons,
    bindingPersisted: false,
    evidenceAuthenticated: false,
    financialBaselineEstablished: false,
    ledgerApplied: false,
    canApplyToLedger: false,
    ownershipVerified: false,
    executionEnabled: false,
    canResend: false,
    canResume: false,
  });
  const parsed = syntheticOrderBindingInputSchema.safeParse(input);
  if (!parsed.success) return finish('blocked', ['INPUT_INVALID']);
  const { context, candidate, intent, attempt, acknowledgement: ack, observation: observed, registry } = parsed.data;
  const missing: Reason[] = [];
  if (!candidate) missing.push('CANDIDATE_MISSING');
  if (!intent) missing.push('INTENT_MISSING');
  if (!attempt) missing.push('ATTEMPT_MISSING');
  if (!ack) missing.push('ACKNOWLEDGEMENT_MISSING');
  if (!candidate || !intent || !attempt || !ack) return finish('unassigned', missing);
  if (ack.kind !== 'synthetic-acceptance')
    return finish('unassigned', [
      ack.kind === 'synthetic-uncertain' ? 'ACKNOWLEDGEMENT_UNCERTAIN' : 'ACKNOWLEDGEMENT_UNATTRIBUTED',
    ]);
  const reasons = new Set<Reason>();
  const ns = namespaceKey(context.namespace);
  if (
    [candidate.namespace, intent.namespace, attempt.namespace, ack.namespace, parsed.data.observationNamespace].some(
      (n) => namespaceKey(n) !== ns,
    )
  )
    reasons.add('NAMESPACE_MISMATCH');
  if (observed.scope !== context.scope) reasons.add('SCOPE_MISMATCH');
  if (
    candidate.intentId !== intent.intentId ||
    attempt.intentId !== intent.intentId ||
    ack.intentId !== intent.intentId
  )
    reasons.add('INTENT_MISMATCH');
  if (!sameStrategy(candidate.strategy, intent.strategy)) reasons.add('STRATEGY_MISMATCH');
  if ([candidate.requestHash, attempt.requestHash, ack.requestHash].some((h) => h !== intent.requestHash))
    reasons.add('REQUEST_HASH_MISMATCH');
  if (candidate.dedupeKey !== intent.dedupeKey) reasons.add('DEDUPE_KEY_MISMATCH');
  if (ack.attemptId !== attempt.attemptId) reasons.add('ATTEMPT_MISMATCH');
  if (ack.originGeneration !== attempt.originGeneration) reasons.add('ORIGIN_MISMATCH');
  if (candidate.orderReference !== ack.orderReference || candidate.orderReference !== observed.orderReference)
    reasons.add('ORDER_REFERENCE_MISMATCH');
  const request = intent.request,
    definition = request.definition;
  if (
    request.instrument.market !== observed.instrument.market ||
    request.instrument.symbol !== observed.instrument.symbol ||
    request.currency !== observed.currency ||
    request.side !== observed.side ||
    definition.type !== observed.definition.type ||
    definition.validity !== observed.definition.validity ||
    !equalMoney(definition.quantity, observed.definition.quantity) ||
    !equalMoney(definition.limitPrice, observed.definition.limitPrice) ||
    !equalMoney(definition.amount, observed.definition.amount)
  )
    reasons.add('REQUEST_MISMATCH');
  if (
    definition.type === 'unknown' ||
    definition.validity === 'unknown' ||
    new Money(definition.quantity).lte(0) ||
    definition.amount != null ||
    (definition.type === 'limit' && (definition.limitPrice == null || new Money(definition.limitPrice).lte(0))) ||
    (definition.type === 'market' && definition.limitPrice != null)
  )
    reasons.add('REQUEST_UNSUPPORTED');
  if (observed.state === 'unknown' || observed.state === 'change-rejected') reasons.add('OBSERVATION_UNSUPPORTED');
  const times = [
    intent.recordedAt,
    attempt.recordedAt,
    observed.definition.orderedAt,
    ack.receivedAt,
    observed.observedAt,
  ].map(Date.parse);
  if (times.some((time, index) => index > 0 && time < times[index - 1]!)) reasons.add('TIMELINE_INVALID');
  if (!registry.complete) reasons.add('REGISTRY_INCOMPLETE');
  const ids = new Set<string>(),
    intents = new Set<string>(),
    orders = new Set<string>(),
    signals = new Set<string>();
  let existing: Binding | undefined;
  for (const binding of registry.bindings) {
    const scope = namespaceKey(binding.namespace);
    const intentKey = JSON.stringify([scope, binding.intentId]),
      orderKey = JSON.stringify([scope, binding.orderReference]),
      signalKey = JSON.stringify([scope, binding.dedupeKey]);
    if (ids.has(binding.bindingId) || intents.has(intentKey) || orders.has(orderKey) || signals.has(signalKey))
      reasons.add('REGISTRY_CONFLICT');
    ids.add(binding.bindingId);
    intents.add(intentKey);
    orders.add(orderKey);
    signals.add(signalKey);
    if (binding.bindingId === candidate.bindingId) {
      existing = binding;
      if (!sameBinding(binding, candidate)) reasons.add('BINDING_ID_REUSED');
    } else if (scope === ns) {
      if (binding.intentId === candidate.intentId) reasons.add('INTENT_ALREADY_BOUND');
      if (binding.dedupeKey === candidate.dedupeKey) reasons.add('SIGNAL_ALREADY_BOUND');
      if (binding.orderReference === candidate.orderReference) reasons.add('ORDER_ALREADY_BOUND');
    }
  }
  if (reasons.size) return finish('blocked', [...reasons]);
  return finish(existing ? 'unchanged-synthetic-binding' : 'consistent-synthetic-binding', []);
}
