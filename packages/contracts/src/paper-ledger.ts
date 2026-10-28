import { z } from 'zod';
import { paperOrderCandidateSchema, paperRiskInputSchema, paperRiskSnapshotSchema } from './risk.js';

export const paperSignalSchema = z
  .object({
    strategyVersion: z.string().min(1).max(40),
    barTimestamp: z.iso.datetime({ offset: true }),
    interval: z.enum(['1m', '1d']),
    adjusted: z.boolean(),
    source: z.string().min(1).max(40),
  })
  .strict();
export const paperLedgerStateSchema = paperRiskSnapshotSchema.omit({
  mode: true,
  accountId: true,
  version: true,
  reservations: true,
});
export const paperEvidenceSchema = paperRiskInputSchema
  .pick({ quote: true, marketData: true })
  .extend({ sourcesHealthy: z.boolean(), hasUnknownOrders: z.boolean() })
  .strict();
export const paperRecordedOrderSchema = z
  .object({ candidate: paperOrderCandidateSchema, signal: paperSignalSchema })
  .strict();
export const paperIntentStateSchema = z.enum(['INTENT_RECORDED', 'READY', 'RISK_REJECTED', 'ABORTED']);
export type PaperSignal = z.infer<typeof paperSignalSchema>;
export type PaperLedgerState = z.infer<typeof paperLedgerStateSchema>;
export type PaperEvidence = z.infer<typeof paperEvidenceSchema>;
export type PaperIntentState = z.infer<typeof paperIntentStateSchema>;
