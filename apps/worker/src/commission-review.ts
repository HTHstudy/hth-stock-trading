import { Decimal } from 'decimal.js';
import { z } from 'zod';

const Money = Decimal.clone({ precision: 100 });
const decimal = z
  .string()
  .regex(/^\d+(\.\d+)?$/)
  .max(30);
const ratio = decimal.refine((value) => new Money(value).lt(1));
const bps = decimal.refine((value) => new Money(value).lt(10_000));
const rate = z
  .object({
    market: z.enum(['KR', 'US']),
    rate: ratio,
    startsOn: z.iso.date().nullable(),
    endsOn: z.iso.date().nullable(),
    periodBoundsKnown: z.boolean(),
  })
  .strict()
  .refine((value) => !value.startsOn || !value.endsOn || value.startsOn <= value.endsOn);

export const commissionEvidenceSchema = z
  .object({
    formatVersion: z.literal('commission-evidence-v1'),
    source: z.literal('toss-readonly'),
    observedAt: z.iso.datetime({ offset: true }),
    rates: z.array(rate).max(100),
    executionEnabled: z.literal(false),
  })
  .strict();
export const commissionAssumptionsSchema = z
  .array(
    z
      .object({
        id: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
        market: z.enum(['KR', 'US']),
        buyFeeBps: bps,
        sellFeeBps: bps,
      })
      .strict(),
  )
  .min(1)
  .max(100)
  .refine((values) => new Set(values.map((value) => value.id)).size === values.length);

export function reviewCommissionAssumptions(evidenceInput: unknown, assumptionsInput: unknown, reviewedAt: string) {
  const evidence = commissionEvidenceSchema.parse(evidenceInput);
  const assumptions = commissionAssumptionsSchema.parse(assumptionsInput);
  z.iso.datetime({ offset: true }).parse(reviewedAt);
  const ageMs = Date.parse(reviewedAt) - Date.parse(evidence.observedAt);
  const fresh = ageMs >= 0 && ageMs <= 300_000;
  // The official Commission bounds use KST, including for US schedules.
  const dateKst = new Date(Date.parse(reviewedAt) + 9 * 3_600_000).toISOString().slice(0, 10);
  const rows = assumptions.map((assumption) => {
    const schedules = evidence.rates.filter((value) => value.market === assumption.market);
    const unknown = schedules.filter((value) => !value.periodBoundsKnown);
    const active = schedules.filter(
      (value) =>
        value.periodBoundsKnown &&
        (value.startsOn === null || value.startsOn <= dateKst) &&
        (value.endsOn === null || value.endsOn >= dateKst),
    );
    const status = !fresh
      ? 'stale'
      : schedules.length === 0
        ? 'missing'
        : active.length > 1 || (active.length > 0 && unknown.length > 0) || unknown.length > 1
          ? 'ambiguous'
          : unknown.length > 0
            ? 'period-unknown'
            : active.length === 0
              ? 'not-effective'
              : 'available';
    const observedCommissionBps = status === 'available' ? new Money(active[0]!.rate).mul(10_000).toFixed() : null;
    return {
      ...assumption,
      status,
      observedCommissionBps,
      buyMatchesObservedRate:
        observedCommissionBps === null ? null : new Money(assumption.buyFeeBps).eq(observedCommissionBps),
      sellMatchesObservedRate:
        observedCommissionBps === null ? null : new Money(assumption.sellFeeBps).eq(observedCommissionBps),
    };
  });
  return {
    formatVersion: 'commission-assumption-review-v1',
    source: evidence.source,
    observedAt: evidence.observedAt,
    reviewedAt,
    dateKst,
    evidenceFresh: fresh,
    dateBoundsPolicy: 'kst-inclusive-comparison-v1',
    periodBoundaryRulesVerified: false,
    freshnessBudgetMs: 300_000,
    rows,
    historicalFeesVerified: false,
    sideSpecificFeesVerified: false,
    taxesVerified: false,
    roundingRulesVerified: false,
    priceTickVerified: false,
    slippageVerified: false,
    assumptionsApplied: false,
    executionEnabled: false,
    canResume: false,
  };
}
