import { parseArgs } from 'node:util';
import { z } from 'zod';
import { paperModeSchema } from '@hth/contracts';
import { testDatabaseUrl } from '@hth/database/testing';

export function parsePaperMarketConfig(args: string[], environment: Record<string, string | undefined>) {
  try {
    paperModeSchema.parse(environment.TRADING_MODE);
    const { values } = parseArgs({
      args,
      options: {
        account: { type: 'string' },
        initialize: { type: 'boolean', default: false },
        prepare: { type: 'boolean', default: false },
        resume: { type: 'boolean', default: false },
        stop: { type: 'boolean', default: false },
        symbol: { type: 'string' },
        ticks: { type: 'string' },
        'share-dashboard': { type: 'boolean', default: false },
      },
    });
    const accountId = z
      .string()
      .regex(/^paper-market-[A-Za-z0-9._:-]{1,70}$/)
      .parse(values.account);
    if (
      (values.stop &&
        (values.initialize ||
          values.prepare ||
          values.resume ||
          values.symbol ||
          values.ticks ||
          values['share-dashboard'])) ||
      (values.resume && (values.initialize || values.prepare)) ||
      (values.symbol && !values.initialize)
    )
      throw new Error('INVALID_FLAGS');
    const symbol = z
      .string()
      .regex(/^(KR|US):[A-Z0-9.-]{1,40}$/)
      .parse(values.symbol ?? 'KR:005930');
    const [market, code] = symbol.split(':');
    const paperUrl = testDatabaseUrl(environment.PAPER_MARKET_DATABASE_URL ?? '');
    const target = new URL(paperUrl);
    if (!['postgres:', 'postgresql:'].includes(target.protocol) || target.search || target.hash)
      throw new Error('INVALID_DATABASE');
    let brokerUrl: string | undefined;
    let clientId: string | undefined;
    let clientSecret: string | undefined;
    if (!values.stop) {
      brokerUrl = z.url().parse(environment.DATABASE_URL);
      const broker = new URL(brokerUrl);
      if (
        !['postgres:', 'postgresql:'].includes(broker.protocol) ||
        broker.search ||
        broker.hash ||
        (['localhost', '127.0.0.1'].includes(broker.hostname) &&
          (broker.port || '5432') === (target.port || '5432') &&
          broker.pathname === target.pathname)
      )
        throw new Error('DATABASES_MUST_DIFFER');
      clientId = z.string().trim().min(1).parse(environment.TOSS_CLIENT_ID);
      clientSecret = z.string().trim().min(1).parse(environment.TOSS_CLIENT_SECRET);
    }
    return {
      accountId,
      paperUrl,
      brokerUrl,
      clientId,
      clientSecret,
      initialize: values.initialize,
      prepare: values.prepare,
      resume: values.resume,
      stop: values.stop,
      shareDashboard: values['share-dashboard'],
      instrument: { market: market as 'KR' | 'US', symbol: code! },
      ticks: z.coerce
        .number()
        .int()
        .min(1)
        .max(1_000_000)
        .parse(values.ticks ?? '1'),
    };
  } catch {
    // Never include Zod input, argument values or connection strings in errors.
    throw new Error('PAPER_MARKET_CONFIGURATION_INVALID');
  }
}
export type PaperMarketConfig = ReturnType<typeof parsePaperMarketConfig>;
