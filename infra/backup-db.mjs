import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, link, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { parseArgs } from 'node:util';

async function main() {
  const { values } = parseArgs({
    options: {
      output: { type: 'string' },
      project: { type: 'string', default: 'hth-local' },
      'env-file': { type: 'string' },
      database: { type: 'string', default: 'broker' },
    },
  });
  if (!/^hth-local(?:-[a-z0-9][a-z0-9-]{0,40})?$/.test(values.project)) throw new Error('INVALID_PROJECT');
  if (!['broker', 'paper'].includes(values.database)) throw new Error('INVALID_DATABASE');
  const root = fileURLToPath(new URL('../', import.meta.url));
  const output = resolve(
    root,
    values.output ?? `.local-data/backups/${values.project}-${values.database}-${Date.now()}-${randomUUID()}.dump`,
  );
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  const temporary = `${output}.tmp-${randomUUID()}`;
  const args = ['compose', '-f', resolve(root, 'infra/compose.local.yml'), '-p', values.project];
  if (values['env-file']) args.push('--env-file', resolve(root, values['env-file']));
  args.push(
    'exec',
    '-T',
    'db',
    'pg_dump',
    '-U',
    values.database === 'paper' ? 'hth_test' : 'hth',
    '-d',
    values.database === 'paper' ? 'hth_readonly_test' : 'hth_trading',
    '--format=custom',
    '--no-owner',
    '--no-acl',
  );
  const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'ignore'] });
  const finished = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error('DUMP_FAILED'))));
  });
  try {
    await Promise.all([finished, pipeline(child.stdout, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }))]);
    // Publish without replacing an existing backup, including symlinks.
    await link(temporary, output);
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    await rm(temporary, { force: true });
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(output)) hash.update(chunk);
  console.info(
    JSON.stringify({
      service: 'local-db-backup',
      state: 'written',
      database: values.database,
      output,
      sha256: hash.digest('hex'),
    }),
  );
}
main().catch(() => {
  console.error(
    JSON.stringify({
      service: 'local-db-backup',
      code: 'BACKUP_FAILED',
      hint: 'Check Docker, project, DB and output permissions',
    }),
  );
  process.exitCode = 1;
});
