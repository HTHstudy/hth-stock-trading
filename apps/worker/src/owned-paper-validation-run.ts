import { fileURLToPath } from 'node:url';
import { runOwnedPaperValidation } from './owned-paper-validation.js';

async function main() {
  const control = new AbortController();
  const stop = () => control.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    const result = await runOwnedPaperValidation(process.argv.slice(2), {
      root: fileURLToPath(new URL('../../../', import.meta.url)),
      environment: { ...process.env, TRADING_MODE: process.env.TRADING_MODE ?? 'paper' },
      signal: control.signal,
    });
    console.info(JSON.stringify(result));
    if ('successful' in result && !result.successful) process.exitCode = 1;
  } finally {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
  }
}

main().catch(() => {
  console.error(
    JSON.stringify({
      service: 'owned-paper-validation',
      code: 'OWNED_PAPER_VALIDATION_NOT_COMPLETED',
      automaticRetry: false,
      executionEnabled: false,
      canResume: false,
    }),
  );
  process.exitCode = 1;
});
