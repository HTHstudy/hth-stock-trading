import { localComposeEnvironment } from '@hth/database/testing';
import { parseWorkerServiceConfig } from './worker-service-config.js';
import { runWorkerService } from './worker-service.js';
async function main() {
  Object.assign(process.env, localComposeEnvironment(process.env));
  const config = parseWorkerServiceConfig(process.env);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await runWorkerService(config, controller.signal);
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
main().catch(() => {
  console.error(JSON.stringify({ service: 'worker-service', code: 'WORKER_SERVICE_FAILED', executionEnabled: false }));
  process.exitCode = 1;
});
