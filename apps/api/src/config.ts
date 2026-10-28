import { paperModeSchema } from '@hth/contracts';
import { z } from 'zod';

const configSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    TRADING_MODE: paperModeSchema,
    API_HOST: z.string().min(1).default('127.0.0.1'),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    DASHBOARD_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
  })
  .superRefine((config, context) => {
    if (
      config.DASHBOARD_ENABLED &&
      (config.NODE_ENV === 'production' || !['127.0.0.1', 'localhost', '::1'].includes(config.API_HOST))
    ) {
      context.addIssue({ code: 'custom', message: 'Dashboard is available on a development loopback server only' });
    }
  });

export function parseApiConfig(environment: Record<string, string | undefined>) {
  return configSchema.parse(environment);
}
