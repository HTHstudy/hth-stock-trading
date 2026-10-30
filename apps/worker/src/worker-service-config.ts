import { z } from 'zod';
import { paperModeSchema, watchlistInstrumentsSchema } from '@hth/contracts';
import { dedicatedPaperDatabaseUrl } from '@hth/database/testing';
import { parseReadonlySymbols } from './readonly-config.js';

export function parseWorkerServiceConfig(environment: Record<string, string | undefined>) {
  try {
    paperModeSchema.parse(environment.TRADING_MODE);
    if (environment.WORKER_RESUME !== undefined && environment.WORKER_RESUME !== 'false')
      throw new Error('RESUME_NOT_SUPPORTED');
    const mode = z.enum(['idle', 'observe', 'paper']).parse(environment.WORKER_MODE ?? 'idle');
    const source = z.enum(['synthetic-only', 'toss-readonly']).parse(environment.WORKER_SOURCE ?? 'synthetic-only');
    const localCompose = environment.LOCAL_CONTAINER_MODE === 'true';
    if (localCompose && environment.NODE_ENV !== 'production') throw new Error('INVALID_SCOPE');
    const intervalSeconds = z.coerce
      .number()
      .int()
      .min(10)
      .max(3600)
      .parse(environment.WORKER_INTERVAL_SECONDS ?? '60');
    if (mode === 'idle')
      return {
        mode,
        source,
        localCompose,
        intervalSeconds,
        requestId: null,
        accountId: null,
        samples: 1,
        symbols: 'KR:005930',
      } as const;
    const instruments = watchlistInstrumentsSchema.parse(
      parseReadonlySymbols(environment.WORKER_SYMBOLS ?? 'KR:005930'),
    );
    if (instruments.length > 5 || (source === 'synthetic-only' && instruments.some((item) => item.market !== 'KR')))
      throw new Error('INVALID_INSTRUMENTS');
    const symbols = instruments.map((item) => `${item.market}:${item.symbol}`).join(',');
    if (mode === 'observe' && source === 'toss-readonly' && new Set(instruments.map((item) => item.market)).size !== 1)
      throw new Error('SINGLE_REGULAR_MARKET_REQUIRED');
    const requestId = mode === 'observe' ? z.uuid().parse(environment.WORKER_REQUEST_ID) : null;
    const samples = z.coerce
      .number()
      .int()
      .min(1)
      .max(10000)
      .parse(environment.WORKER_SAMPLES ?? '60');
    const accountId =
      mode === 'paper'
        ? z
            .string()
            .regex(
              source === 'synthetic-only'
                ? /^paper-demo-[A-Za-z0-9._:-]{1,80}$/
                : /^paper-market-[A-Za-z0-9._:-]{1,70}$/,
            )
            .parse(environment.LOCAL_PAPER_ACCOUNT_ID)
        : null;
    if (mode === 'paper')
      dedicatedPaperDatabaseUrl(
        source === 'synthetic-only' ? environment.PAPER_DEMO_DATABASE_URL : environment.PAPER_MARKET_DATABASE_URL,
        localCompose,
      );
    if (source === 'toss-readonly') {
      z.string().min(1).parse(environment.TOSS_CLIENT_ID?.trim());
      z.string().min(1).parse(environment.TOSS_CLIENT_SECRET?.trim());
      const db = new URL(z.string().min(1).parse(environment.DATABASE_URL));
      if (!['postgres:', 'postgresql:'].includes(db.protocol) || db.search || db.hash)
        throw new Error('INVALID_DATABASE');
    }
    return { mode, source, localCompose, intervalSeconds, requestId, accountId, samples, symbols } as const;
  } catch {
    throw new Error('WORKER_SERVICE_CONFIGURATION_INVALID');
  }
}
export type WorkerServiceConfig = ReturnType<typeof parseWorkerServiceConfig>;
export function workerCommand(config: WorkerServiceConfig) {
  if (config.mode === 'idle') return null;
  if (config.mode === 'observe')
    return [
      'market-observation-run.js',
      ...(config.source === 'synthetic-only' ? ['--demo'] : ['--regular-only', '--share-dashboard']),
      `--symbols=${config.symbols}`,
      `--samples=${config.samples}`,
      `--interval-seconds=${config.intervalSeconds}`,
    ];
  return config.source === 'synthetic-only'
    ? ['paper-service-run.js', `--account=${config.accountId}`]
    : ['paper-market-run.js', `--account=${config.accountId}`, '--ticks=1000000', '--share-dashboard'];
}
