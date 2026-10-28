import { paperModeSchema } from '@hth/contracts';

try {
  const mode = paperModeSchema.parse(process.env.TRADING_MODE);
  console.info(JSON.stringify({ service: 'worker', mode, state: 'idle', executionEnabled: false }));

  const keepAlive = setInterval(() => {}, 60_000);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      clearInterval(keepAlive);
      console.info(JSON.stringify({ service: 'worker', state: 'stopped' }));
    });
  }
} catch {
  console.error('Worker startup failed. Only paper mode is supported.');
  process.exitCode = 1;
}
