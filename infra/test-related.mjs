import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, relative, isAbsolute } from 'node:path';

const cwd = fileURLToPath(new URL('../', import.meta.url));
try {
  const changed = [...new Set(process.argv.slice(2).map((path) => resolve(cwd, path)))];
  if (
    changed.some((path) => {
      const name = relative(cwd, path);
      return name === '..' || name.startsWith('../') || isAbsolute(name);
    })
  )
    throw new Error('RELATED_TEST_PATH_INVALID');
  if (changed.length) {
    const env = { ...process.env };
    delete env.TEST_DATABASE_URL;
    const run = (args) => {
      const result = spawnSync('corepack', ['pnpm', ...args], { cwd, env, stdio: 'inherit' });
      if (result.error || result.status !== 0) throw new Error('RELATED_TEST_STEP_FAILED');
    };
    const needsBuild = changed.some(
      (path) => /^(apps|packages)\//.test(relative(cwd, path)) || relative(cwd, path) === 'vitest.config.ts',
    );
    if (needsBuild) {
      run(['build:packages']);
      run(['--filter', '@hth/worker', 'build']);
    }
    const targets = new Set(changed);
    for (const path of changed) {
      const sibling = path.replace(/\.(?:[cm]?js|tsx?)$/, '.test.ts');
      if (existsSync(sibling)) targets.add(sibling);
      // Public package imports resolve to dist; track the matching compiled
      // module and entrypoint as well as source after rebuilding dependencies.
      if (/^(packages\/[^/]+|apps\/worker)\/src\//.test(relative(cwd, path)) && !path.endsWith('.test.ts')) {
        const compiled = path.replace('/src/', '/dist/').replace(/\.tsx?$/, '.js');
        if (existsSync(compiled)) targets.add(compiled);
        const entry = resolve(cwd, relative(cwd, path).split('/').slice(0, 2).join('/'), 'dist/index.js');
        if (existsSync(entry)) targets.add(entry);
      }
    }
    console.info(JSON.stringify({ service: 'test-related', changedFiles: changed.length, databaseTests: false }));
    run([
      'exec',
      'vitest',
      'related',
      '--run',
      '--exclude',
      '**/*.integration.test.ts',
      '--passWithNoTests',
      ...targets,
    ]);
  }
} catch (error) {
  console.error(
    JSON.stringify({
      service: 'test-related',
      code:
        error instanceof Error && error.message === 'RELATED_TEST_PATH_INVALID'
          ? error.message
          : 'RELATED_TEST_STEP_FAILED',
    }),
  );
  process.exitCode = 1;
}
