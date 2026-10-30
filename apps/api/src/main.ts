import { createWatchlistStore, environmentWatchlist } from './watchlist-store.js';
import { createApp } from './app.js';
import { createOwnerAuth } from './owner-auth.js';
import { createDatabase } from '@hth/database';
import {
  assertDedicatedPaperDatabase,
  dedicatedPaperDatabaseUrl,
  localComposeEnvironment,
} from '@hth/database/testing';
import { createPaperDashboard } from './paper-dashboard.js';
import { fileURLToPath } from 'node:url';
import { createObservationReports } from './observation-reports.js';
import { createBacktestReports } from './backtest-reports.js';
import { parseApiConfig } from './config.js';
import { createDashboardService, loadDashboardFromWorker } from './dashboard-service.js';
import { createWorkerStatus } from './worker-status.js';

async function main() {
  Object.assign(process.env, localComposeEnvironment(process.env));
  const config = parseApiConfig(process.env);
  const localAccess =
    (config.NODE_ENV !== 'production' || config.LOCAL_CONTAINER_MODE) &&
    ['127.0.0.1', 'localhost', '::1'].includes(config.API_HOST);
  const watchlist = localAccess
    ? createWatchlistStore(
        fileURLToPath(new URL('../../../.local-data/settings', import.meta.url)),
        environmentWatchlist(process.env.READONLY_SYMBOLS),
      )
    : undefined;
  const dashboard = createDashboardService({
    enabled: config.DASHBOARD_ENABLED,
    configured: Boolean(
      process.env.TOSS_CLIENT_ID?.trim() && process.env.TOSS_CLIENT_SECRET?.trim() && process.env.DATABASE_URL?.trim(),
    ),
    load: async (signal) =>
      loadDashboardFromWorker(signal, watchlist ? (await watchlist.read()).instruments : undefined),
  });
  const origins = [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    `http://localhost:${config.API_PORT}`,
    `http://127.0.0.1:${config.API_PORT}`,
    `http://localhost:${config.LOCAL_WEB_PORT}`,
    `http://127.0.0.1:${config.LOCAL_WEB_PORT}`,
  ];
  const reports = localAccess
    ? createBacktestReports(fileURLToPath(new URL('../../../.local-data', import.meta.url)))
    : undefined;
  const observations = localAccess
    ? createObservationReports(
        fileURLToPath(new URL('../../../.local-data/observations', import.meta.url)),
        fileURLToPath(new URL('../../../.local-data/scheduled-observations', import.meta.url)),
      )
    : undefined;
  const paperUrl =
    config.PAPER_DASHBOARD_KIND === 'market' ? config.PAPER_MARKET_DATABASE_URL : config.PAPER_DEMO_DATABASE_URL;
  const paperDatabase = config.PAPER_DASHBOARD_ENABLED
    ? createDatabase(dedicatedPaperDatabaseUrl(paperUrl, config.LOCAL_CONTAINER_MODE))
    : undefined;
  if (paperDatabase) {
    try {
      await assertDedicatedPaperDatabase(paperDatabase, paperUrl!, config.LOCAL_CONTAINER_MODE);
    } catch (error) {
      await paperDatabase.close();
      throw error;
    }
  }
  const paper = paperDatabase
    ? createPaperDashboard(
        paperDatabase,
        (config.PAPER_DASHBOARD_KIND === 'market' ? config.PAPER_MARKET_ACCOUNT_ID : config.PAPER_DEMO_ACCOUNT_ID)!,
        config.PAPER_DASHBOARD_KIND === 'market' ? 'toss-readonly' : 'synthetic-only',
      )
    : undefined;
  const app = createApp(
    config.LOG_LEVEL,
    dashboard,
    origins,
    reports,
    paper,
    createOwnerAuth(config.OWNER_PASSWORD_HASH),
    observations,
    watchlist,
    localAccess
      ? createWorkerStatus(fileURLToPath(new URL('../../../.local-data/runtime', import.meta.url)))
      : undefined,
  );

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void app.close();
    });
  }

  try {
    await app.listen({ host: config.API_HOST, port: config.API_PORT });
  } catch (error) {
    await app.close();
    throw error;
  }
  dashboard.refresh();
}

main().catch(() => {
  console.error('API startup failed. Check configuration and port availability.');
  process.exitCode = 1;
});
