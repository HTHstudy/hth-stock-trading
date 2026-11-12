import { z } from 'zod';
import { decimalSchema } from './primitives.js';
export const orderReconciliationReportSchema = z.strictObject({
  formatVersion: z.literal('order-reconciliation-v1'),
  outcome: z.enum([
    'blocked',
    'baseline-required',
    'unchanged',
    'progress',
    'cost-adjustment',
    'metadata-change',
    'review-required',
  ]),
  reasons: z
    .array(
      z.enum([
        'INPUT_INVALID',
        'BASELINE_REQUIRED',
        'IDENTITY_CHANGED',
        'DEFINITION_CHANGED',
        'OBSERVATION_REVERSED',
        'CONFLICTING_OBSERVATION',
        'TIMELINE_INVALID',
        'QUANTITY_REVERSED',
        'AMOUNT_REVERSED',
        'TERMINAL_CHANGED',
        'STATE_QUANTITY_MISMATCH',
        'UNKNOWN_DEFINITION_OR_STATE',
        'CHANGE_REJECTION_RECORD',
        'AMOUNT_ORDER_UNSUPPORTED',
        'TOTALS_UNKNOWN',
        'FILL_TIME_UNKNOWN',
        'FILL_TIME_REVERSED',
        'AMOUNT_NOT_INCREASED',
        'AMOUNT_CORRECTION',
        'AVERAGE_PRICE_CORRECTION',
        'COST_CORRECTION_WITH_FILL',
      ]),
    )
    .max(32),
  delta: z
    .strictObject({
      quantity: decimalSchema.max(100),
      amount: decimalSchema.max(100).nullable(),
      commission: decimalSchema.max(100).nullable(),
      tax: decimalSchema.max(100).nullable(),
    })
    .nullable(),
  ledgerApplied: z.literal(false),
  canApplyToLedger: z.literal(false),
  ownershipVerified: z.literal(false),
  executionEnabled: z.literal(false),
  canResend: z.literal(false),
  canResume: z.literal(false),
});
export type OrderReconciliationReport = z.infer<typeof orderReconciliationReportSchema>;
