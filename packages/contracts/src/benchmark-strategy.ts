import { z } from 'zod';

export const buyAndHoldConfigSchema = z.object({ entryAfterClosedCandles: z.number().int().min(1).max(2001) }).strict();

export type BuyAndHoldConfig = z.infer<typeof buyAndHoldConfigSchema>;
