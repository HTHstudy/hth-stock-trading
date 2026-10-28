import { z } from 'zod';

export const ownerLoginSchema = z.object({ password: z.string().min(16).max(256) }).strict();
export const ownerSessionSchema = z
  .object({
    configured: z.boolean(),
    authenticated: z.boolean(),
    expiresAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .strict();
export type OwnerSession = z.infer<typeof ownerSessionSchema>;
