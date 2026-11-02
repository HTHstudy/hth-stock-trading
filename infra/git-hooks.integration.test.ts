import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, symlink, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
it('실제 pre-commit이 포맷 오류 커밋을 차단하고 부분 스테이징과 작업 파일을 보존한다', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hth-hook-test-'));
  const env: Record<string, string | undefined> = { ...process.env, HUSKY: '1', COREPACK_ENABLE_NETWORK: '0' };
  // A real push exports repository-local Git variables to its hook children.
  // Remove them before creating the test repository so it cannot use the parent's index.
  const localVars = spawnSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8' });
  expect(localVars.status).toBe(0);
  for (const key of localVars.stdout.trim().split('\n')) delete env[key];
  const run = (command: string, args: string[]) => spawnSync(command, args, { cwd: directory, env, encoding: 'utf8' });
  const git = (...args: string[]) => run('git', args);
  const commit = () => git('-c', 'commit.gpgsign=false', 'commit', '-m', 'test: hook');
  try {
    await mkdir(join(directory, '.husky'));
    await symlink(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir');
    await writeFile(join(directory, '.gitignore'), 'node_modules/\n');
    const { packageManager } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    await writeFile(join(directory, 'package.json'), JSON.stringify({ private: true, packageManager }, null, 2) + '\n');
    await copyFile(join(root, '.lintstagedrc.json'), join(directory, '.lintstagedrc.json'));
    await copyFile(join(root, '.husky/pre-commit'), join(directory, '.husky/pre-commit'));
    expect(git('init', '--quiet').status).toBe(0);
    expect(git('config', 'user.name', 'Hook Test').status).toBe(0);
    expect(git('config', 'user.email', 'hook-test@example.invalid').status).toBe(0);
    expect(run(process.execPath, [join(root, 'node_modules/husky/bin.js')]).status).toBe(0);
    expect(git('add', '.').status).toBe(0);
    const initial = commit();
    expect(initial.status, initial.stdout + initial.stderr).toBe(0);
    const before = git('rev-parse', 'HEAD').stdout;
    const file = join(directory, 'data.json');
    await writeFile(file, '{"value":1}\n');
    expect(git('add', 'data.json').status).toBe(0);
    const blocked = commit();
    expect(blocked.status).not.toBe(0);
    expect(blocked.stdout + blocked.stderr).toContain('prettier');
    expect(git('rev-parse', 'HEAD').stdout).toBe(before);
    expect(await readFile(file, 'utf8')).toBe('{"value":1}\n');
    const staged = '{ "value": 1 }\n';
    await writeFile(file, staged);
    expect(git('add', 'data.json').status).toBe(0);
    const unstaged = '{"value":2}\n';
    await writeFile(file, unstaged);
    const accepted = commit();
    expect(accepted.status, accepted.stdout + accepted.stderr).toBe(0);
    expect(git('show', 'HEAD:data.json').stdout).toBe(staged);
    expect(await readFile(file, 'utf8')).toBe(unstaged);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 20000);
