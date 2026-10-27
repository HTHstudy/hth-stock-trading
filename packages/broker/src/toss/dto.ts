import { decimalSchema, instantSchema } from '@hth/shared';
import { z } from 'zod';

const decimal = decimalSchema.max(30);
const nonnegative = decimal.refine((value) => !value.startsWith('-'));
const currency = z.string().min(1);
const session = z
  .object({ startTime: instantSchema, endTime: instantSchema })
  .refine((value) => Date.parse(value.endTime) > Date.parse(value.startTime));

export const tokenDto = z.object({
  access_token: z.string().min(1),
  token_type: z.literal('Bearer'),
  expires_in: z.number().int().positive().max(31_536_000),
});

export const accountsDto = z.object({
  result: z.array(
    z.object({
      accountSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      accountType: z.string().min(1),
    }),
  ),
});

export const holdingsDto = z.object({
  result: z.object({
    items: z.array(
      z.object({
        symbol: z.string().min(1),
        name: z.string(),
        marketCountry: z.string().min(1),
        currency,
        quantity: nonnegative,
        lastPrice: nonnegative,
        averagePurchasePrice: nonnegative,
      }),
    ),
  }),
});

export const instrumentsDto = z.object({
  result: z.array(
    z.object({
      symbol: z.string().min(1),
      name: z.string(),
      market: z.string().min(1),
      status: z.string().min(1),
      currency,
      koreanMarketDetail: z
        .object({
          krxTradingSuspended: z.boolean(),
          nxtTradingSuspended: z.boolean().nullish(),
        })
        .nullish(),
    }),
  ),
});

export const quotesDto = z.object({
  result: z.array(
    z.object({
      symbol: z.string().min(1),
      lastPrice: nonnegative,
      currency,
      timestamp: instantSchema.nullish(),
    }),
  ),
});

export const candlesDto = z.object({
  result: z.object({
    candles: z
      .array(
        z.object({
          timestamp: instantSchema,
          openPrice: nonnegative,
          highPrice: nonnegative,
          lowPrice: nonnegative,
          closePrice: nonnegative,
          volume: nonnegative,
          currency,
        }),
      )
      .max(200),
    nextBefore: instantSchema.nullish(),
  }),
});

export const buyingPowerDto = z.object({ result: z.object({ currency, cashBuyingPower: nonnegative }) });

export const exchangeRateDto = z.object({
  result: z
    .object({
      baseCurrency: currency,
      quoteCurrency: currency,
      rate: nonnegative.refine((value) => /[1-9]/.test(value)),
      midRate: nonnegative.refine((value) => /[1-9]/.test(value)),
      validFrom: instantSchema,
      validUntil: instantSchema,
    })
    .refine((value) => Date.parse(value.validUntil) > Date.parse(value.validFrom)),
});

const krDay = z.object({
  date: z.iso.date(),
  integrated: z
    .object({ preMarket: session.nullish(), regularMarket: session.nullish(), afterMarket: session.nullish() })
    .nullish(),
});
const usDay = z.object({
  date: z.iso.date(),
  dayMarket: session.nullish(),
  preMarket: session.nullish(),
  regularMarket: session.nullish(),
  afterMarket: session.nullish(),
});

export const krCalendarDto = z.object({
  result: z.object({ today: krDay, previousBusinessDay: krDay, nextBusinessDay: krDay }),
});
export const usCalendarDto = z.object({
  result: z.object({ today: usDay, previousBusinessDay: usDay, nextBusinessDay: usDay }),
});
