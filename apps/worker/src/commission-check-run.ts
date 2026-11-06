import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { BrokerError } from '@hth/broker';
import { createTossReadonlyBroker } from '@hth/broker/toss';
import { paperModeSchema } from '@hth/contracts';
import { createDatabase } from '@hth/database';
import { writeExperimentResult } from './backtest-experiment-files.js';
import { commissionEvidenceSchema } from './commission-review.js';
import { parseReadonlyConnectionConfig } from './readonly-config.js';

async function main() {
  if (!paperModeSchema.safeParse(process.env.TRADING_MODE).success) throw new Error('TRADING_MODE_INVALID');
  let options;
  try {
    options = parseArgs({
      options: { check: { type: 'boolean' }, output: { type: 'string' } },
      tokens: true,
      allowPositionals: false,
      strict: true,
    });
  } catch {
    throw new Error('INVALID_OPTIONS');
  }
  const seen = new Set<string>();
  for (const token of options.tokens) {
    if (token.kind !== 'option' || seen.has(token.name)) throw new Error('INVALID_OPTIONS');
    seen.add(token.name);
  }
  if (options.tokens.length === 0) {
    console.info(JSON.stringify({ service: 'commission-check', state: 'preview', executionEnabled: false }));
    return;
  }
  const { check, output } = options.values;
  if (!check || !output) throw new Error('INVALID_OPTIONS');
  if (!/\.json$/i.test(output)) throw new Error('EXPERIMENT_OUTPUT_JSON_REQUIRED');
  const config = parseReadonlyConnectionConfig(process.env);
  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  const timeout = setTimeout(stop, 30_000);
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const database = createDatabase(config.DATABASE_URL);
    const key = createHash('sha256').update(config.TOSS_CLIENT_ID).digest().readInt32BE(0);
    const evidence = await database
      .withBrokerLease(key, async (leaseSignal) => {
        const lifetimeAbort = new AbortController();
        const signal = AbortSignal.any([shutdown.signal, leaseSignal, lifetimeAbort.signal]);
        try {
          signal.throwIfAborted();
          const broker = createTossReadonlyBroker({
            clientId: config.TOSS_CLIENT_ID,
            clientSecret: config.TOSS_CLIENT_SECRET,
            signal,
            timeoutMs: 30_000,
          });
          const accounts = await broker.listAccounts();
          signal.throwIfAborted();
          if (accounts.length !== 1) throw new Error('ACCOUNT_SELECTION_REQUIRED');
          const rates = await broker.getCommissionRates(accounts[0]!);
          signal.throwIfAborted();
          return commissionEvidenceSchema.parse({
            formatVersion: 'commission-evidence-v1',
            source: 'toss-readonly',
            observedAt: new Date().toISOString(),
            rates,
            executionEnabled: false,
          });
        } finally {
          // All reads above settle before aborting the broker lifetime and unlocking.
          lifetimeAbort.abort();
        }
      })
      .finally(() => database.close());
    shutdown.signal.throwIfAborted();
    await writeExperimentResult(output, evidence);
    console.info(
      JSON.stringify({
        service: 'commission-check',
        state: 'checked',
        rows: evidence.rates.length,
        executionEnabled: false,
      }),
    );
  } finally {
    shutdown.abort();
    clearTimeout(timeout);
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

main().catch((error: unknown) => {
  const known = [
    'TRADING_MODE_INVALID',
    'INVALID_OPTIONS',
    'EXPERIMENT_OUTPUT_JSON_REQUIRED',
    'READONLY_CONFIGURATION_INVALID',
    'ACCOUNT_SELECTION_REQUIRED',
    'BROKER_LEASE_BUSY',
    'BROKER_LEASE_LOST',
  ];
  const code =
    error instanceof BrokerError
      ? error.code
      : error instanceof Error && known.includes(error.message)
        ? error.message
        : 'COMMISSION_CHECK_NOT_COMPLETED';
  console.error(JSON.stringify({ service: 'commission-check', code, executionEnabled: false }));
  process.exitCode = 1;
});
