import { z } from 'zod';
import { orderObservationSchema } from './order-observation.js';
import { syntheticOrderBindingInputSchema } from './synthetic-order-binding.js';
import { decimalSchema } from './primitives.js';
const uuid = z.uuid().transform((v) => v.toLowerCase());
const money = decimalSchema.max(30).refine((v) => !v.startsWith('-'));
const signedMoney = decimalSchema.max(30);
const quantity = z.string().regex(/^\d+$/).max(20);
const instrument = orderObservationSchema.shape.instrument;
const candidate = syntheticOrderBindingInputSchema.shape.candidate.unwrap();
export const syntheticLedgerPositionSchema = z.strictObject({
  instrument,
  manualQuantity: quantity,
  owners: z.array(z.strictObject({ strategyId: candidate.shape.strategy.shape.id, quantity, basis: money })).max(32),
});
export const syntheticLedgerOrderSchema = z.strictObject({
  binding: candidate,
  sequence: z.number().int().min(0).max(512),
  observation: orderObservationSchema,
  reservedCash: money,
  reservedQuantity: quantity,
});
export const syntheticLedgerStateSchema = z.strictObject({
  formatVersion: z.literal('synthetic-ledger-state-v1'),
  source: z.literal('synthetic-fixture'),
  model: z.literal('native-currency-unsettled-v1'),
  namespace: syntheticOrderBindingInputSchema.shape.context.shape.namespace,
  scope: syntheticOrderBindingInputSchema.shape.context.shape.scope,
  version: z.number().int().min(0).max(544),
  cash: z.strictObject({ KRW: money, USD: money }),
  receivables: z.strictObject({ KRW: money, USD: money }),
  realizedPnl: z.strictObject({ KRW: signedMoney, USD: signedMoney }),
  positions: z.array(syntheticLedgerPositionSchema).max(256),
  orders: z.array(syntheticLedgerOrderSchema).max(32),
});
export const syntheticLedgerInitializationSchema = z.strictObject({
  source: z.literal('synthetic-fixture'),
  namespace: syntheticLedgerStateSchema.shape.namespace,
  scope: syntheticLedgerStateSchema.shape.scope,
  cash: syntheticLedgerStateSchema.shape.cash,
  positions: z.array(z.strictObject({ instrument, manualQuantity: quantity })).max(256),
});
export const syntheticLedgerRegistrationSchema = z.strictObject({
  source: z.literal('synthetic-fixture'),
  state: syntheticLedgerStateSchema,
  proof: syntheticOrderBindingInputSchema,
  reservedCash: money,
  reservedQuantity: quantity,
});
export const syntheticLedgerApplicationSchema = z.strictObject({
  source: z.literal('synthetic-fixture'),
  state: syntheticLedgerStateSchema,
  bindingId: uuid,
  sequence: z.number().int().min(1).max(512),
  observation: orderObservationSchema,
});
export const syntheticLedgerEffectSchema = z.strictObject({
  bindingId: uuid,
  sequence: z.number().int().min(1).max(512),
  currency: z.enum(['KRW', 'USD']),
  quantity: quantity,
  amount: money,
  commission: money,
  tax: money,
  cashDelta: signedMoney,
  receivableDelta: signedMoney,
  releasedBasis: money,
  realizedPnl: signedMoney,
});
export type SyntheticLedgerState = z.infer<typeof syntheticLedgerStateSchema>;
export type SyntheticLedgerEffect = z.infer<typeof syntheticLedgerEffectSchema>;
