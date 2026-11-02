import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('../', import.meta.url));
const git = (...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error('PUSH_GIT_CHECK_FAILED');
  return result.stdout.trim();
};
try {
  const refs = readFileSync(0, 'utf8').trim().split('\n').filter(Boolean);
  const updates = refs
    .map((line) => {
      const parts = line.trim().split(/\s+/);
      if (parts.length !== 4 || !/^[a-f0-9]{40,64}$/.test(parts[1])) throw new Error('PUSH_REF_INVALID');
      return parts[1];
    })
    .filter((sha) => !/^0+$/.test(sha));
  if (updates.length) {
    const head = git('rev-parse', 'HEAD');
    if (updates.some((sha) => sha !== head)) throw new Error('PUSH_CURRENT_HEAD_REQUIRED');
    // Otherwise an uncommitted fix could hide a failure in the pushed commit.
    if (git('status', '--porcelain=v1', '--untracked-files=normal')) throw new Error('PUSH_CLEAN_WORKTREE_REQUIRED');
    for (const args of [
      ['corepack', 'pnpm', 'verify:ci'],
      ['docker', 'compose', '-f', 'infra/docker-compose.yml', 'config', '--quiet'],
      ['docker', 'compose', '-f', 'infra/compose.local.yml', 'config', '--quiet'],
    ]) {
      const [command, ...options] = args;
      const result = spawnSync(command, options, { cwd, env: process.env, stdio: 'inherit' });
      if (result.error || result.status !== 0) {
        process.exitCode = result.status || 1;
        break;
      }
    }
  }
} catch (error) {
  const allowed = new Set([
    'PUSH_GIT_CHECK_FAILED',
    'PUSH_REF_INVALID',
    'PUSH_CURRENT_HEAD_REQUIRED',
    'PUSH_CLEAN_WORKTREE_REQUIRED',
  ]);
  console.error(
    JSON.stringify({
      service: 'verify-push',
      code: error instanceof Error && allowed.has(error.message) ? error.message : 'PUSH_CHECK_FAILED',
    }),
  );
  process.exitCode = 1;
}
