import { z } from 'zod';
import { currencySchema, decimalSchema, instantSchema } from './primitives.js';

const amount = decimalSchema.max(30).refine((value) => !value.startsWith('-'));
const instant = instantSchema.refine((value) => /\.\d{3}(?:Z|[+-]\d{2}:\d{2})$/.test(value));
export const observedOrderStateSchema = z.enum([
  'pending',
  'partial',
  'filled',
  'cancel-pending',
  'replace-pending',
  'canceled',
  'rejected',
  'replaced',
  'change-rejected',
  'unknown',
]);
/** Server-only observation: scope is supplied by the trusted account/broker context. */
export const orderObservationSchema = z
  .strictObject({
    formatVersion: z.literal('order-observation-v1'),
    scope: z.string().regex(/^[a-f0-9]{64}$/),
    observedAt: instant,
    orderReference: z
      .string()
      .min(1)
      .max(512)
      .refine((value) =>
        [...value].every((c) => {
          const p = c.codePointAt(0)!;
          return p >= 32 && p !== 127 && !(p >= 0xd800 && p <= 0xdfff);
        }),
      ),
    instrument: z.strictObject({
      market: z.enum(['KR', 'US']),
      symbol: z
        .string()
        .regex(/^[A-Z0-9.-]+$/)
        .max(40),
    }),
    side: z.enum(['BUY', 'SELL']),
    currency: currencySchema,
    definition: z.strictObject({
      type: z.enum(['limit', 'market', 'unknown']),
      validity: z.enum(['day', 'opening', 'closing', 'unknown']),
      quantity: amount,
      limitPrice: amount.nullable().optional(),
      amount: amount.nullable().optional(),
      orderedAt: instant,
    }),
    state: observedOrderStateSchema,
    canceledAt: instant.nullable().optional(),
    execution: z.strictObject({
      quantity: amount,
      averagePrice: amount.nullable(),
      amount: amount.nullable(),
      commission: amount.nullable(),
      tax: amount.nullable(),
      lastFilledAt: instant.nullable(),
      settlementDate: z.iso.date().nullable(),
    }),
  })
  .refine((v) => v.currency === (v.instrument.market === 'KR' ? 'KRW' : 'USD'));
export type OrderObservation = z.infer<typeof orderObservationSchema>;
