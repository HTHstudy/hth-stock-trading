import { z } from 'zod';

export const ENV = z.object({ API_URL: z.url().default('http://localhost:4000') }).parse({
  API_URL: import.meta.env.VITE_API_URL,
});
