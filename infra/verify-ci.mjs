import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

try {
  if (process.argv.length !== 2 || process.env.VITEST_MAX_WORKERS !== undefined)
    throw new Error('VERIFY_CI_ARGUMENT_OVERRIDE_REJECTED');
  if (!process.env.TEST_DATABASE_URL) throw new Error('VERIFY_CI_DEDICATED_DATABASE_REQUIRED');
  const database = new URL(process.env.TEST_DATABASE_URL);
  if (
    !['postgres:', 'postgresql:'].includes(database.protocol) ||
    !['localhost', '127.0.0.1'].includes(database.hostname) ||
    database.username !== 'hth_test' ||
    database.pathname !== '/hth_readonly_test' ||
    database.search ||
    database.hash
  )
    throw new Error('VERIFY_CI_DEDICATED_DATABASE_REQUIRED');
  const cwd = fileURLToPath(new URL('../', import.meta.url));
  for (const step of ['format:check', 'lint', 'typecheck', 'test', 'build']) {
    console.info(JSON.stringify({ service: 'verify-ci', step, state: 'started' }));
    const result = spawnSync('corepack', ['pnpm', step], {
      cwd,
      env: { ...process.env, CI: 'true' },
      stdio: 'inherit',
    });
    if (result.error || result.status !== 0) {
      console.error(JSON.stringify({ service: 'verify-ci', step, code: 'VERIFY_STEP_FAILED' }));
      process.exit(result.status || 1);
    }
  }
  console.info(JSON.stringify({ service: 'verify-ci', state: 'passed' }));
} catch (error) {
  const allowed = new Set(['VERIFY_CI_ARGUMENT_OVERRIDE_REJECTED', 'VERIFY_CI_DEDICATED_DATABASE_REQUIRED']);
  console.error(
    JSON.stringify({
      service: 'verify-ci',
      code: error instanceof Error && allowed.has(error.message) ? error.message : 'VERIFY_CI_CONFIGURATION_INVALID',
    }),
  );
  process.exitCode = 1;
}
