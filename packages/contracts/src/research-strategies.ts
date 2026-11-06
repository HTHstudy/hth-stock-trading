import { z } from 'zod';

const period = z.number().int().min(2).max(2000);

export const channelBreakoutConfigSchema = z
  .object({ entryPeriod: period, exitPeriod: period })
  .strict()
  .refine((value) => value.exitPeriod <= value.entryPeriod);

export const meanReversionConfigSchema = z
  .object({
    period,
    entryDeviationBps: z
      .string()
      .max(30)
      .regex(/^\d+(\.\d+)?$/)
      .refine((value) => {
        if (!/^\d+(\.\d+)?$/.test(value) || value.length > 30) return false;
        const [whole = ''] = value.split('.');
        return /[1-9]/.test(value) && BigInt(whole) < 10000n;
      }),
  })
  .strict();

export type ChannelBreakoutConfig = z.infer<typeof channelBreakoutConfigSchema>;
export type MeanReversionConfig = z.infer<typeof meanReversionConfigSchema>;
