import { createApp } from './app.js';
import { createOwnerAuth } from './owner-auth.js';
import { createDatabase } from '@hth/database';
import { testDatabaseUrl } from '@hth/database/testing';
import { createPaperDashboard } from './paper-dashboard.js';
import { fileURLToPath } from 'node:url';
import { createBacktestReports } from './backtest-reports.js';
import { parseApiConfig } from './config.js';
import { createDashboardService, loadDashboardFromWorker } from './dashboard-service.js';

async function main() {
  const config = parseApiConfig(process.env);
  const dashboard = createDashboardService({
    enabled: config.DASHBOARD_ENABLED,
    configured: Boolean(
      process.env.TOSS_CLIENT_ID?.trim() && process.env.TOSS_CLIENT_SECRET?.trim() && process.env.DATABASE_URL?.trim(),
    ),
    load: loadDashboardFromWorker,
  });
  const origins = [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    `http://localhost:${config.API_PORT}`,
    `http://127.0.0.1:${config.API_PORT}`,
  ];
  const reports =
    config.NODE_ENV !== 'production' && ['127.0.0.1', 'localhost', '::1'].includes(config.API_HOST)
      ? createBacktestReports(fileURLToPath(new URL('../../../.local-data', import.meta.url)))
      : undefined;
  const paper = config.PAPER_DASHBOARD_ENABLED
    ? createPaperDashboard(
        createDatabase(
          testDatabaseUrl(
            (config.PAPER_DASHBOARD_KIND === 'market'
              ? config.PAPER_MARKET_DATABASE_URL
              : config.PAPER_DEMO_DATABASE_URL)!,
          ),
        ),
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
