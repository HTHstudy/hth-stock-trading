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
  source: z.literal('mock-wire-v1'),
  accountId: uuid,
  brokerId: z.literal('toss'),
  scopeHash: orderAttemptHashSchema,
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
export const durableOrderResultSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    ...safety,
    outcome: z.literal('acknowledged'),
    reference: z
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
      ),
    status: z.literal(200),
  }),
  z.strictObject({
    ...safety,
    outcome: z.enum(['unknown', 'not-sent']),
    code: errorCode,
    status: z.number().int().min(100).max(599).nullable(),
  }),
]);
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
