import { randomBytes } from 'node:crypto';
import { mkdir, lstat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

try {
  const directory = new URL('../.local-data/paper-market-local/', import.meta.url);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink()) throw new Error('INVALID_DIRECTORY');
  const adminPassword = randomBytes(32).toString('hex');
  const paperPassword = randomBytes(32).toString('hex');
  await writeFile(
    new URL('.env', directory),
    [
      'TRADING_MODE=paper',
      'PAPER_LOCAL_PORT=55434',
      `PAPER_LOCAL_ADMIN_PASSWORD=${adminPassword}`,
      `PAPER_LOCAL_PASSWORD=${paperPassword}`,
      `PAPER_MARKET_DATABASE_URL=postgresql://hth_test:${paperPassword}@127.0.0.1:55434/hth_readonly_test`,
      '',
    ].join('\n'),
    { flag: 'wx', mode: 0o600 },
  );
  console.info(
    JSON.stringify({
      service: 'paper-local-config',
      state: 'created',
      path: fileURLToPath(new URL('.env', directory)),
      executionEnabled: false,
    }),
  );
} catch {
  console.error(
    JSON.stringify({ service: 'paper-local-config', code: 'PAPER_LOCAL_CONFIG_NOT_CREATED', executionEnabled: false }),
  );
  process.exitCode = 1;
}
