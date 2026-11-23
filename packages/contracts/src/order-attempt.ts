import { z } from 'zod';
import { orderObservationSchema } from './order-observation.js';
const uuid = z.uuid().transform((v) => v.toLowerCase());
export const orderAttemptHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const instant = z.iso.datetime({ offset: true });
const integer = z.string().regex(/^[1-9]\d{0,19}$/);
const decimal = z
  .string()
  .regex(/^(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/)
  .max(30)
  .refine((v) => /[1-9]/.test(v));
/** Canonical internal profile, not an external broker DTO or a dispatch permit. */
export const durableOrderRequestSchema = z
  .strictObject({
    profile: z.literal('limit-day-integer-v1'),
    clientOrderId: uuid,
    instrument: z.strictObject({ market: z.enum(['KR', 'US']), symbol: z.string().regex(/^[A-Z0-9.-]{1,40}$/) }),
    side: z.enum(['BUY', 'SELL']),
    quantity: integer,
    limitPrice: decimal,
  })
  .refine((v) => {
    const [whole, fraction = ''] = v.limitPrice.split('.');
    return v.instrument.market === 'KR'
      ? /^[A-Z0-9]{6}$/.test(v.instrument.symbol) && fraction.length === 0
      : fraction.length <= (whole === '0' ? 4 : 2);
  });
export const orderAttemptContextSchema = z.strictObject({
  source: z.enum(['mock-wire-v1', 'mock-resource-v1']),
  accountId: uuid,
  brokerId: z.literal('toss'),
  scopeHash: orderAttemptHashSchema,
  recoveryPublicKey: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export const durableOrderIntentSchema = z.strictObject({
  intentId: uuid,
  signalId: uuid,
  strategyId: uuid,
  strategyRevision: z.number().int().min(1).max(2147483647),
  request: durableOrderRequestSchema,
  expiresAt: instant,
  // These are local unapplied totals before dispatch, not fabricated provider observations.
  internalOpening: z.strictObject({
    quantity: z.literal('0'),
    amount: z.literal('0'),
    commission: z.literal('0'),
    tax: z.literal('0'),
  }),
});
const safety = {
  mode: z.literal('mock'),
  executionEnabled: z.literal(false),
  ownershipVerified: z.literal(false),
  canApplyToLedger: z.literal(false),
  canResend: z.literal(false),
  replayed: z.boolean(),
  clientOrderId: uuid,
};
const errorCode = z.enum([
  'INVALID_INPUT',
  'INVALID_RESPONSE',
  'UNSUPPORTED_MARKET',
  'AUTHENTICATION_FAILED',
  'PERMISSION_DENIED',
  'RATE_LIMITED',
  'UPSTREAM_REJECTED',
  'UPSTREAM_UNAVAILABLE',
  'NETWORK_ERROR',
  'TIMEOUT',
  'CANCELLED',
  'ORDER_EXECUTION_DISABLED',
  'ORDER_ATTEMPT_CONFLICT',
  'ORDER_ATTEMPT_LIMIT',
]);
const orderReference = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (v) =>
      v !== '.' &&
      v !== '..' &&
      [...v].every((c) => {
        const n = c.codePointAt(0)!;
        return n >= 32 && n !== 127 && !(n >= 0xd800 && n <= 0xdfff);
      }),
  );
export const durableOrderResultSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    ...safety,
    outcome: z.literal('acknowledged'),
    reference: orderReference,
    status: z.literal(200),
  }),
  z.strictObject({
    ...safety,
    outcome: z.enum(['unknown', 'not-sent']),
    code: errorCode,
    status: z.number().int().min(100).max(599).nullable(),
  }),
]);
const decimalCash = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/);
const cash = decimalCash.max(30);
const units = z.string().regex(/^(?:0|[1-9]\d{0,22})$/);
const instrument = durableOrderRequestSchema.shape.instrument;
const funds = z.strictObject({ KRW: cash, USD: cash });
const holding = z.strictObject({ instrument, quantity: units });
const accountOpening = z.strictObject({
  cash: funds,
  manual: z.array(holding).max(32),
  managed: z.array(holding.extend({ strategyId: uuid })).max(32),
});
const accountObservation = z.strictObject({
  scopeHash: orderAttemptHashSchema,
  observedAt: instant,
  cash: z.strictObject({ KRW: decimalCash.max(64), USD: decimalCash.max(64) }),
  holdings: z.array(holding.extend({ quantity: z.string().regex(/^(?:0|[1-9]\d{0,24})$/) })).max(64),
});
const recoveryReceipt = z.strictObject({
  format: z.literal('mock-order-ack-v1'),
  proofId: uuid,
  accountId: uuid,
  scopeHash: orderAttemptHashSchema,
  attemptId: uuid,
  intentHash: orderAttemptHashSchema,
  claimEventHash: orderAttemptHashSchema,
  unknownEventHash: orderAttemptHashSchema,
  clientOrderId: uuid,
  reference: orderReference,
  capturedAt: instant,
});
export const orderAttemptEventDataSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('open'), ownerId: uuid }),
  z.strictObject({ kind: z.literal('pause') }),
  z.strictObject({ kind: z.literal('heartbeat'), ownerId: uuid, epoch: z.number().int().nonnegative() }),
  z.strictObject({ kind: z.literal('intent'), intent: durableOrderIntentSchema }),
  z.strictObject({
    kind: z.literal('attempt'),
    intentId: uuid,
    attemptId: uuid,
    intentHash: orderAttemptHashSchema,
    ownerId: uuid,
    epoch: z.number().int().nonnegative(),
  }),
  z.strictObject({ kind: z.literal('result'), attemptId: uuid, result: durableOrderResultSchema }),
  z.strictObject({
    kind: z.literal('observe-fill'),
    attemptId: uuid,
    observation: orderObservationSchema,
  }),
  z.strictObject({
    kind: z.literal('apply-fill'),
    attemptId: uuid,
    observationSequence: z.number().int().min(1).max(512),
  }),
  z.strictObject({ kind: z.literal('resource-opening'), opening: accountOpening }),
  z.strictObject({ kind: z.literal('resource-observe'), observation: accountObservation }),
  z.strictObject({ kind: z.literal('resource-reserve'), intentId: uuid, cashBudget: cash.nullable() }),
  z.strictObject({
    kind: z.literal('resource-final'),
    attemptId: uuid,
    closedAt: instant,
    observation: orderObservationSchema.refine((v) => v.state === 'canceled' || v.state === 'expired'),
  }),
  z.strictObject({
    kind: z.literal('resource-release'),
    intentId: uuid,
    reason: z.enum(['local-canceled', 'intent-expired', 'not-sent', 'canceled', 'expired']),
  }),
  z.strictObject({
    kind: z.literal('recovery-review'),
    attemptId: uuid,
    reason: z.enum(['no-correlated-evidence', 'unverified-candidate', 'detail-inconclusive']),
  }),
  z.strictObject({
    kind: z.literal('recovery-detail'),
    attemptId: uuid,
    reference: orderReference,
    evidence: z.discriminatedUnion('outcome', [
      z.strictObject({ outcome: z.literal('observed'), observation: orderObservationSchema }),
      z.strictObject({ outcome: z.enum(['http-404', 'unavailable', 'invalid-response']) }),
    ]),
  }),
  z.strictObject({
    kind: z.literal('recovery-ack'),
    receipt: recoveryReceipt,
    signature: z.string().regex(/^[a-f0-9]{128}$/),
  }),
]);
export const orderAttemptCommandSchema = z.strictObject({
  operationId: uuid,
  expectedVersion: z.number().int().min(0).max(512),
  expectedStateHash: orderAttemptHashSchema,
  data: orderAttemptEventDataSchema,
});
export const storedOrderAttemptEventSchema = z.strictObject({
  operationId: uuid,
  sequence: z.number().int().min(1).max(512),
  commandHash: orderAttemptHashSchema,
  previousHash: orderAttemptHashSchema,
  at: instant,
  data: orderAttemptEventDataSchema,
  eventHash: orderAttemptHashSchema,
});
export type DurableOrderIntent = z.infer<typeof durableOrderIntentSchema>;
export type DurableOrderResult = z.infer<typeof durableOrderResultSchema>;
export type OrderAttemptContext = z.infer<typeof orderAttemptContextSchema>;
export type OrderAttemptEventData = z.infer<typeof orderAttemptEventDataSchema>;
export type StoredOrderAttemptEvent = z.infer<typeof storedOrderAttemptEventSchema>;
