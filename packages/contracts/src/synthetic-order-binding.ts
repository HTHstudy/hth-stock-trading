import { z } from 'zod';
import { orderObservationSchema } from './order-observation.js';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const instant = orderObservationSchema.shape.observedAt;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const generation = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER - 2);
const namespace = z.strictObject({
  brokerId: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
  environment: z.literal('synthetic-fixture'),
  accountId: uuid,
});
const strategy = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/),
  revision: generation,
  definitionHash: hash,
});
const request = z
  .strictObject({
    instrument: orderObservationSchema.shape.instrument,
    currency: orderObservationSchema.shape.currency,
    side: orderObservationSchema.shape.side,
    definition: orderObservationSchema.shape.definition.omit({ orderedAt: true }),
  })
  .refine((v) => v.currency === (v.instrument.market === 'KR' ? 'KRW' : 'USD'));
const binding = z.strictObject({
  bindingId: uuid,
  namespace,
  intentId: uuid,
  strategy,
  requestHash: hash,
  dedupeKey: hash,
  orderReference: orderObservationSchema.shape.orderReference,
});
/** Synthetic assertions only; neither hashes nor acceptance labels authenticate a real order. */
export const syntheticOrderBindingInputSchema = z.strictObject({
  formatVersion: z.literal('synthetic-order-binding-input-v1'),
  source: z.literal('synthetic-fixture'),
  context: z.strictObject({ namespace, scope: hash, connectionGeneration: generation }),
  candidate: binding.nullable(),
  intent: z
    .strictObject({
      namespace,
      intentId: uuid,
      strategy,
      requestHash: hash,
      dedupeKey: hash,
      recordedAt: instant,
      request,
    })
    .nullable(),
  attempt: z
    .strictObject({
      namespace,
      attemptId: uuid,
      intentId: uuid,
      requestHash: hash,
      originGeneration: generation,
      recordedAt: instant,
    })
    .nullable(),
  acknowledgement: z
    .strictObject({
      kind: z.enum(['synthetic-acceptance', 'synthetic-uncertain', 'synthetic-unattributed']),
      namespace,
      attemptId: uuid.nullable(),
      intentId: uuid.nullable(),
      requestHash: hash.nullable(),
      originGeneration: generation,
      orderReference: orderObservationSchema.shape.orderReference,
      receivedAt: instant,
    })
    .nullable(),
  observationNamespace: namespace,
  observation: orderObservationSchema,
  registry: z.strictObject({ complete: z.boolean(), bindings: z.array(binding).max(256) }),
});
export const syntheticOrderBindingReviewSchema = z.strictObject({
  formatVersion: z.literal('synthetic-order-binding-review-v1'),
  outcome: z.enum(['consistent-synthetic-binding', 'unchanged-synthetic-binding', 'unassigned', 'blocked']),
  reasons: z
    .array(
      z.enum([
        'INPUT_INVALID',
        'INTENT_MISSING',
        'CANDIDATE_MISSING',
        'ATTEMPT_MISSING',
        'ACKNOWLEDGEMENT_MISSING',
        'ACKNOWLEDGEMENT_UNCERTAIN',
        'ACKNOWLEDGEMENT_UNATTRIBUTED',
        'NAMESPACE_MISMATCH',
        'SCOPE_MISMATCH',
        'INTENT_MISMATCH',
        'STRATEGY_MISMATCH',
        'REQUEST_HASH_MISMATCH',
        'DEDUPE_KEY_MISMATCH',
        'ATTEMPT_MISMATCH',
        'ORIGIN_MISMATCH',
        'ORDER_REFERENCE_MISMATCH',
        'REQUEST_MISMATCH',
        'REQUEST_UNSUPPORTED',
        'OBSERVATION_UNSUPPORTED',
        'TIMELINE_INVALID',
        'REGISTRY_INCOMPLETE',
        'REGISTRY_CONFLICT',
        'BINDING_ID_REUSED',
        'INTENT_ALREADY_BOUND',
        'SIGNAL_ALREADY_BOUND',
        'ORDER_ALREADY_BOUND',
      ]),
    )
    .max(32),
  bindingPersisted: z.literal(false),
  evidenceAuthenticated: z.literal(false),
  financialBaselineEstablished: z.literal(false),
  ledgerApplied: z.literal(false),
  canApplyToLedger: z.literal(false),
  ownershipVerified: z.literal(false),
  executionEnabled: z.literal(false),
  canResend: z.literal(false),
  canResume: z.literal(false),
});
export type SyntheticOrderBindingInput = z.infer<typeof syntheticOrderBindingInputSchema>;
export type SyntheticOrderBindingReview = z.infer<typeof syntheticOrderBindingReviewSchema>;
