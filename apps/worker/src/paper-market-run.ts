import { BrokerError } from '@hth/broker';
import { createTossReadonlyBroker } from '@hth/broker/toss';
import { createDatabase } from '@hth/database';
import { migrateTestDatabase } from '@hth/database/testing';
import { parsePaperMarketConfig } from './paper-market-config.js';
import { runPaperMarket } from './paper-market-runtime.js';
import { createPaperWorker } from './paper-worker.js';
import { shareDashboardBroker } from './shared-dashboard-broker.js';

async function main() {
  const config = parsePaperMarketConfig(process.argv.slice(2), process.env);
  const database = createDatabase(config.paperUrl);
  const brokerDatabase = config.stop ? undefined : createDatabase(config.brokerUrl!);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const report = (details: Record<string, unknown>) =>
    console.info(
      JSON.stringify({
        service: 'paper-market',
        mode: 'paper',
        source: 'toss-readonly',
        executionEnabled: false,
        ...details,
      }),
    );
  try {
    await runPaperMarket(
      config,
      {
        paper: database.paper,
        prepare: () => migrateTestDatabase(database, config.paperUrl),
        withBrokerLease: (key, operation) => {
          if (!brokerDatabase) throw new Error('PAPER_MARKET_BROKER_UNAVAILABLE');
          return brokerDatabase.withBrokerLease(key, operation);
        },
        createBroker: createTossReadonlyBroker,
        shareDashboard: (broker, signal) =>
          shareDashboardBroker(
            {
              clientId: config.clientId!,
              clientSecret: config.clientSecret!,
              databaseUrl: config.brokerUrl!,
              interval: '1m',
            },
            broker,
            signal,
          ),
        createWorker: (value, source) => createPaperWorker(database.paper, value, source),
      },
      controller.signal,
      (status) => report({ ...status }),
    );
    report({ state: 'stopped' });
  } catch (error) {
    if (!controller.signal.aborted) throw error;
    report({ state: 'stopped' });
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await Promise.allSettled([database.close(), brokerDatabase?.close()]);
  }
}
main().catch((error: unknown) => {
  const known = new Set([
    'PAPER_MARKET_CONFIGURATION_INVALID',
    'PAPER_SOURCE_MISMATCH',
    'BROKER_LEASE_BUSY',
    'BROKER_LEASE_LOST',
    'PAPER_MARKET_ACCOUNT_EXISTS',
    'PAPER_MARKET_STRATEGIES_INVALID',
    'PAPER_MARKET_INSTRUMENT_LIMIT',
    'PAPER_WORKER_DATA_NOT_READY',
    'PAPER_TRADING_DAY_REVIEW_REQUIRED',
    'PAPER_OBSERVATION_STALE',
    'PAPER_WORKER_NO_ENABLED_STRATEGIES',
    'PAPER_LEASE_NOT_OWNED',
    'PAPER_CONTROL_CHANGED',
    'DASHBOARD_SHARE_UNAVAILABLE',
  ]);
  const code =
    error instanceof BrokerError
      ? error.code
      : error instanceof Error && known.has(error.message)
        ? error.message
        : 'PAPER_MARKET_FAILED';
  console.error(JSON.stringify({ service: 'paper-market', code, executionEnabled: false }));
  process.exitCode = 1;
});
