import { paperModeSchema } from '@hth/contracts';
import { testDatabaseUrl } from '@hth/database/testing';
import { z } from 'zod';
import { ownerHashPattern } from './owner-auth.js';

const configSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    TRADING_MODE: paperModeSchema,
    API_HOST: z.string().min(1).default('127.0.0.1'),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    OWNER_PASSWORD_HASH: z.string().regex(ownerHashPattern).optional(),
    DASHBOARD_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    PAPER_DASHBOARD_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    PAPER_DASHBOARD_KIND: z.enum(['synthetic', 'market']).default('synthetic'),
    PAPER_MARKET_DATABASE_URL: z.string().min(1).optional(),
    PAPER_MARKET_ACCOUNT_ID: z
      .string()
      .regex(/^paper-market-[A-Za-z0-9._:-]{1,70}$/)
      .optional(),
    PAPER_DEMO_DATABASE_URL: z.string().min(1).optional(),
    PAPER_DEMO_ACCOUNT_ID: z
      .string()
      .regex(/^paper-demo-[A-Za-z0-9._:-]{1,80}$/)
      .optional(),
  })
  .superRefine((config, context) => {
    if ((config.DASHBOARD_ENABLED || config.PAPER_DASHBOARD_ENABLED) && !config.OWNER_PASSWORD_HASH)
      context.addIssue({
        code: 'custom',
        message: 'Owner authentication must be configured before enabling dashboards',
      });
    if (
      (config.DASHBOARD_ENABLED || config.PAPER_DASHBOARD_ENABLED) &&
      (config.NODE_ENV === 'production' || !['127.0.0.1', 'localhost', '::1'].includes(config.API_HOST))
    ) {
      context.addIssue({ code: 'custom', message: 'Dashboard is available on a development loopback server only' });
    }
    if (config.PAPER_DASHBOARD_ENABLED) {
      const market = config.PAPER_DASHBOARD_KIND === 'market';
      const url = market ? config.PAPER_MARKET_DATABASE_URL : config.PAPER_DEMO_DATABASE_URL;
      const account = market ? config.PAPER_MARKET_ACCOUNT_ID : config.PAPER_DEMO_ACCOUNT_ID;
      try {
        if (!url || !account) throw new Error('MISSING_CONFIGURATION');
        testDatabaseUrl(url);
        const target = new URL(url);
        if (!['postgres:', 'postgresql:'].includes(target.protocol) || target.search || target.hash)
          throw new Error('UNSAFE_DATABASE');
      } catch {
        context.addIssue({
          code: 'custom',
          message: 'Paper dashboard requires a dedicated loopback test DB and matching account configuration',
        });
      }
    }
  });

export function parseApiConfig(environment: Record<string, string | undefined>) {
  return configSchema.parse(environment);
}
