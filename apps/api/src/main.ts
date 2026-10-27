import { createApp } from './app.js';
import { parseApiConfig } from './config.js';

async function main() {
  const config = parseApiConfig(process.env);
  const app = createApp(config.LOG_LEVEL);

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void app.close();
    });
  }

  await app.listen({ host: config.API_HOST, port: config.API_PORT });
}

main().catch(() => {
  console.error('API startup failed. Check configuration and port availability.');
  process.exitCode = 1;
});
