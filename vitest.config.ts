import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['apps/**/*.test.ts', 'packages/**/*.test.ts'],
    clearMocks: true,
    restoreMocks: true,
    env: { NODE_ENV: 'test', TRADING_MODE: 'paper' },
  },
});
