import { fileURLToPath } from 'node:url';
import { runReadonlyProcessCheck } from './readonly-process-check.js';
const controller = new AbortController();
const stop = () => controller.abort();
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
runReadonlyProcessCheck(
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
      JSON.stringify({ service: 'readonly-process-check', code: 'PROCESS_CHECK_FAILED', executionEnabled: false }),
    );
    process.exitCode = 1;
  })
  .finally(() => {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  });
