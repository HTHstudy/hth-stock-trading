import { fileURLToPath } from 'node:url';
import { runReadonlySupervisor } from './readonly-observation-supervisor.js';
const controller = new AbortController();
const stop = () => controller.abort();
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
runReadonlySupervisor(
  process.argv.slice(2),
  process.env,
  fileURLToPath(new URL('../../../', import.meta.url)),
  controller.signal,
)
  .then((result) => {
    console.info(JSON.stringify(result));
    if (result.state === 'failed') process.exitCode = 1;
  })
  .catch(() => {
    console.error(
      JSON.stringify({
        service: 'readonly-observation-supervisor',
        code: 'SUPERVISOR_FAILED',
        executionEnabled: false,
      }),
    );
    process.exitCode = 1;
  })
  .finally(() => {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  });
