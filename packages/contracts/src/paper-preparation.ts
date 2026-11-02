import { z } from 'zod';

const checks = z
  .object({
    paperSource: z.boolean(),
    stopped: z.boolean(),
    noLease: z.boolean(),
    initialControl: z.boolean(),
    limitsMatch: z.boolean(),
    initialCash: z.boolean(),
    emptyPositions: z.boolean(),
    unreconciled: z.boolean(),
    initialPnl: z.boolean(),
    noOrders: z.boolean(),
    noFills: z.boolean(),
    noReservations: z.boolean(),
    strategyMatches: z.boolean(),
    historyMatches: z.boolean(),
    preparationReceipt: z.boolean(),
  })
  .strict();
const decimal = z
  .string()
  .regex(/^\d+(\.\d+)?$/)
  .max(80);
const details = z
  .object({
    observedAt: z.iso.datetime({ offset: true }),
    clockVerified: z.boolean(),
    preparationMatches: z.boolean(),
    stopped: z.boolean(),
    leasePresent: z.boolean(),
    checks,
    dailyReviewRequired: z.boolean().nullable(),
    dailyDates: z
      .array(z.object({ currency: z.enum(['KRW', 'USD']), stored: z.iso.date(), current: z.iso.date() }).strict())
      .length(2),
    plan: z
      .object({
        hash: z.string().regex(/^[a-f0-9]{64}$/),
        symbol: z.string().min(1).max(40),
        currency: z.enum(['KRW', 'USD']),
        cash: decimal,
        maxOrderAmount: decimal,
        maxInstrumentAmount: decimal,
        maxDailyLoss: decimal,
        maxPositions: z.number().int().positive(),
        fastPeriod: z.number().int().positive(),
        slowPeriod: z.number().int().positive(),
        quantity: decimal,
        maxFillQuantity: decimal,
      })
      .strict(),
  })
  .strict();
export const paperPreparationDashboardSchema = z
  .object({
    status: z.enum(['disabled', 'ready', 'unavailable']),
    asOf: z.iso.datetime({ offset: true }),
    executionEnabled: z.literal(false),
    canResume: z.literal(false),
    marketReadiness: z.literal('not-checked'),
    accounts: z
      .array(
        z
          .object({
            market: z.enum(['KR', 'US']),
            status: z.enum(['available', 'unavailable']),
            details: details.nullable(),
          })
          .strict(),
      )
      .max(2),
  })
  .strict();
export type PaperPreparationDashboard = z.infer<typeof paperPreparationDashboardSchema>;
