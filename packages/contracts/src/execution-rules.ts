import { z } from 'zod';

const nonnegativeDecimal = z
  .string()
  .regex(/^\d+(\.\d+)?$/)
  .max(30);

function minimumWithinMaximum(minimum: string, maximum: string | null): boolean {
  if (maximum === null) return true;
  // Refinements can run alongside string validation; never parse invalid input.
  if (![minimum, maximum].every((value) => value.length <= 30 && /^\d+(\.\d+)?$/.test(value))) return false;
  const [minWhole, minFraction = ''] = minimum.split('.');
  const [maxWhole, maxFraction = ''] = maximum.split('.');
  const scale = Math.max(minFraction.length, maxFraction.length);
  return (
    BigInt(`${minWhole}${minFraction.padEnd(scale, '0')}`) <= BigInt(`${maxWhole}${maxFraction.padEnd(scale, '0')}`)
  );
}

const feeRuleSchema = z
  .object({
    rounding: z.enum(['ceil', 'floor']),
    minimum: nonnegativeDecimal,
    maximum: nonnegativeDecimal.nullable(),
  })
  .strict()
  .refine((value) => minimumWithinMaximum(value.minimum, value.maximum), {
    path: ['maximum'],
    message: 'Maximum must be at least minimum',
  });

export const executionRulesSchema = z
  .object({
    formatVersion: z.literal('execution-rules-v1'),
    priceRule: z.enum(['fixed', 'krx-kospi-equity-2023']),
    venueAssumption: z.enum(['unspecified', 'KRX']),
    boardAssumption: z.enum(['unspecified', 'KOSPI']),
    assetClassAssumption: z.enum(['unspecified', 'common-stock']),
    buyFee: feeRuleSchema,
    sellFee: feeRuleSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.priceRule === 'fixed'
        ? value.venueAssumption === 'unspecified' &&
          value.boardAssumption === 'unspecified' &&
          value.assetClassAssumption === 'unspecified'
        : value.venueAssumption === 'KRX' &&
          value.boardAssumption === 'KOSPI' &&
          value.assetClassAssumption === 'common-stock',
    { message: 'Price rule requires matching explicit assumptions' },
  );

export type ExecutionRules = z.infer<typeof executionRulesSchema>;
