import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('../', import.meta.url));
const git = (...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error('PUSH_GIT_CHECK_FAILED');
  return result.stdout.trim();
};
async function verify(needsDatabase) {
  const name = 'hth-push-test-' + randomUUID();
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  const run = (command, args, { capture = false, env = process.env, signal = controller.signal } = {}) =>
    new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        env,
        signal,
        stdio: ['ignore', capture ? 'pipe' : 'inherit', capture ? 'ignore' : 'inherit'],
      });
      let stdout = '';
      child.stdout?.on('data', (chunk) => {
        stdout = (stdout + chunk).slice(-4096);
      });
      child.once('error', () =>
        reject(new Error(controller.signal.aborted ? 'PUSH_CANCELLED' : 'PUSH_TOOL_UNAVAILABLE')),
      );
      child.once('close', (code) => resolve({ code: code ?? 1, stdout: stdout.trim() }));
    });
  const docker = (args, options = {}) => run('docker', args, { capture: true, ...options });
  let created = false;
  let attempted = false;
  try {
    const fastEnv = { ...process.env };
    delete fastEnv.TEST_DATABASE_URL;
    console.info(
      JSON.stringify({
        service: 'verify-push',
        state: 'typecheck-and-unit-tests',
        databaseTestsRequired: needsDatabase,
      }),
    );
    for (const args of [
      ['pnpm', 'typecheck'],
      ['pnpm', 'exec', 'vitest', 'run', '--exclude', '**/*.integration.test.ts'],
    ]) {
      const result = await run('corepack', args, { env: fastEnv });
      if (result.code !== 0) {
        process.exitCode = result.code;
        return;
      }
    }
    if (!needsDatabase) return;
    attempted = true;
    console.info(JSON.stringify({ service: 'verify-push', state: 'creating-isolated-test-database' }));
    const started = await docker([
      'run',
      '--rm',
      '--detach',
      '--name',
      name,
      '--label',
      'hth.purpose=push-verification',
      '--env',
      'POSTGRES_USER=hth_test',
      '--env',
      'POSTGRES_PASSWORD=local_test_only',
      '--env',
      'POSTGRES_DB=hth_readonly_test',
      '--publish',
      '127.0.0.1::5432',
      'postgres:17-alpine',
    ]);
    if (started.code !== 0) throw new Error('PUSH_TEST_DATABASE_START_FAILED');
    created = true;
    const mapping = await docker(['port', name, '5432']);
    const port = /^127\.0\.0\.1:(\d{1,5})$/.exec(mapping.stdout)?.[1];
    if (mapping.code !== 0 || !port || Number(port) < 1 || Number(port) > 65535)
      throw new Error('PUSH_TEST_DATABASE_PORT_INVALID');
    const deadline = Date.now() + 30000;
    while (
      (await docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'hth_test', '-d', 'hth_readonly_test']))
        .code !== 0
    ) {
      if (Date.now() >= deadline) throw new Error('PUSH_TEST_DATABASE_NOT_READY');
      await delay(250, undefined, { signal: controller.signal });
    }
    // Never reuse an inherited URL: the same DB name can also contain Paper assets.
    const env = {
      ...process.env,
      TEST_DATABASE_URL: `postgresql://hth_test:local_test_only@127.0.0.1:${port}/hth_readonly_test`,
    };
    const result = await run('corepack', ['pnpm', 'exec', 'vitest', 'run', '.integration.test.ts'], { env });
    if (result.code !== 0) process.exitCode = result.code;
  } finally {
    try {
      // Cleanup has its own signal so Ctrl-C cannot cancel removal of our DB.
      const removed = attempted
        ? await docker(['rm', '--force', name], { signal: AbortSignal.timeout(10000) }).catch(() => ({
            code: 1,
          }))
        : { code: 0 };
      if (created && removed.code !== 0) {
        console.error(
          JSON.stringify({ service: 'verify-push', code: 'PUSH_TEST_DATABASE_CLEANUP_FAILED', container: name }),
        );
        process.exitCode = 1;
      }
    } finally {
      process.removeListener('SIGINT', abort);
      process.removeListener('SIGTERM', abort);
    }
  }
}
try {
  const refs = readFileSync(0, 'utf8').trim().split('\n').filter(Boolean);
  const updates = refs
    .map((line) => {
      const parts = line.trim().split(/\s+/);
      if (parts.length !== 4 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(parts[1])) throw new Error('PUSH_REF_INVALID');
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(parts[3])) throw new Error('PUSH_REF_INVALID');
      return { sha: parts[1], previous: parts[3] };
    })
    .filter((update) => !/^0+$/.test(update.sha));
  if (updates.length) {
    const head = git('rev-parse', 'HEAD');
    if (updates.some((update) => update.sha !== head)) throw new Error('PUSH_CURRENT_HEAD_REQUIRED');
    if (git('status', '--porcelain=v1', '--untracked-files=normal')) throw new Error('PUSH_CLEAN_WORKTREE_REQUIRED');
    const critical = (path) =>
      [
        'packages/database/',
        'packages/trading/',
        'packages/contracts/',
        'apps/worker/src/paper-',
        'apps/api/src/paper-',
        'infra/verify-push',
      ].some((prefix) => path.startsWith(prefix)) ||
      ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'].includes(path) ||
      /^tsconfig[^/]*\.json$/.test(path);
    const needsDatabase = updates.some((update) => {
      if (/^0+$/.test(update.previous)) return true;
      const changed = spawnSync('git', ['diff', '--name-only', '-z', '--no-renames', update.previous, head, '--'], {
        cwd,
        encoding: 'utf8',
      });
      return changed.error || changed.status !== 0 || changed.stdout.split('\0').some((path) => critical(path));
    });
    await verify(Boolean(needsDatabase));
  }
} catch (error) {
  const allowed = new Set([
    'PUSH_GIT_CHECK_FAILED',
    'PUSH_REF_INVALID',
    'PUSH_CURRENT_HEAD_REQUIRED',
    'PUSH_CLEAN_WORKTREE_REQUIRED',
    'PUSH_CANCELLED',
    'PUSH_TOOL_UNAVAILABLE',
    'PUSH_TEST_DATABASE_START_FAILED',
    'PUSH_TEST_DATABASE_PORT_INVALID',
    'PUSH_TEST_DATABASE_NOT_READY',
    'PUSH_TEST_DATABASE_CLEANUP_FAILED',
  ]);
  console.error(
    JSON.stringify({
      service: 'verify-push',
      code: error instanceof Error && allowed.has(error.message) ? error.message : 'PUSH_CHECK_FAILED',
    }),
  );
  process.exitCode = 1;
}
