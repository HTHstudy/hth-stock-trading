import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { availableParallelism } from 'node:os';

export default defineConfig({
  resolve: {
    alias: {
      '@app': fileURLToPath(new URL('./apps/web/src/app', import.meta.url)),
      '@pages': fileURLToPath(new URL('./apps/web/src/pages', import.meta.url)),
      '@shared': fileURLToPath(new URL('./apps/web/src/shared', import.meta.url)),
    },
  },
  test: {
    // CLI tests spawn Node and Git children too; leave room for their deadlines.
    maxWorkers: Math.min(4, availableParallelism()),
    environment: 'node',
    include: ['apps/**/*.test.ts', 'packages/**/*.test.ts', 'infra/**/*.test.ts'],
    clearMocks: true,
    restoreMocks: true,
    env: { NODE_ENV: 'test', TRADING_MODE: 'paper' },
  },
});
