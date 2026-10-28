import { z } from 'zod';

export const ENV = z.object({ API_URL: z.literal('/api').default('/api') }).parse({
  API_URL: import.meta.env.VITE_API_URL,
});
