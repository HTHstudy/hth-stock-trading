import { createApp } from './app.js';
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
  const app = createApp(config.LOG_LEVEL, dashboard, origins);

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void app.close();
    });
  }

  await app.listen({ host: config.API_HOST, port: config.API_PORT });
  dashboard.refresh();
}

main().catch(() => {
  console.error('API startup failed. Check configuration and port availability.');
  process.exitCode = 1;
});
