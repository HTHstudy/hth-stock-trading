import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { paperModeSchema } from '@hth/contracts';
import { createDatabase } from '@hth/database';
import { migrateTestDatabase, testDatabaseUrl } from '@hth/database/testing';
import { marketTradingDate, movingAverageCross } from '@hth/trading';
import { createPaperWorker } from './paper-worker.js';
import { paperSyntheticSource } from './paper-synthetic-source.js';

async function main() {
  paperModeSchema.parse(process.env.TRADING_MODE);
  const { values } = parseArgs({
    options: {
      account: { type: 'string' },
      resume: { type: 'boolean', default: false },
      prepare: { type: 'boolean', default: false },
      stop: { type: 'boolean', default: false },
      ticks: { type: 'string' },
    },
  });
  const id = z
    .string()
    .regex(/^paper-demo-[A-Za-z0-9._:-]{1,80}$/)
    .parse(values.account ?? `paper-demo-${randomUUID()}`);
  const ticks =
    values.ticks === undefined ? Infinity : z.coerce.number().int().min(1).max(1_000_000).parse(values.ticks);
  if (values.stop && (values.resume || values.prepare)) throw new Error('PAPER_DEMO_FLAGS_INVALID');
  const url = testDatabaseUrl(process.env.PAPER_DEMO_DATABASE_URL ?? '');
  const database = createDatabase(url);
  const controller = new AbortController();
  const shutdown = () => controller.abort();
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  const report = (details: Record<string, unknown>) =>
    console.info(
      JSON.stringify({
        service: 'paper-worker-demo',
        mode: 'paper',
        source: 'synthetic-only',
        executionEnabled: false,
        ...details,
      }),
    );
  try {
    if (values.prepare) await migrateTestDatabase(database, url);
    if (values.stop) {
      await database.paper.stop(id, 'DEMO_EMERGENCY_STOP');
      report({ state: 'stopped' });
      return;
    }
    const now = new Date().toISOString();
    const created = await database.paper.createAccount(id, {
      cash: { KRW: '15000', USD: '1000' },
      positions: [],
      observedAt: now,
      reconciled: false,
      dailyPnl: {
        KRW: { tradingDate: marketTradingDate(Date.parse(now), 'KR'), netPnl: '0' },
        USD: { tradingDate: marketTradingDate(Date.parse(now), 'US'), netPnl: '0' },
      },
    });
    if (created.created) {
      const limits = {
        KRW: {
          maxOrderAmount: '100000',
          maxInstrumentAmount: '200000',
          maxDailyLoss: '10000',
          buyCostBps: '10',
          sellCostBps: '30',
        },
        USD: {
          maxOrderAmount: '1000',
          maxInstrumentAmount: '2000',
          maxDailyLoss: '100',
          buyCostBps: '10',
          sellCostBps: '30',
        },
        maxPositions: 5,
      };
      const version = await database.paper.configureLimits(id, 0, limits);
      await database.paper.configureStrategy(id, version, {
        id: 'demo-ma',
        version: movingAverageCross.version,
        enabled: true,
      });
    }
    const worker = createPaperWorker(
      database.paper,
      {
        accountId: id,
        resume: values.resume,
        strategies: [
          {
            id: 'demo-ma',
            instrument: { market: 'KR', symbol: '005930' },
            parameters: { fastPeriod: 1, slowPeriod: 2 },
            quantity: '2',
            maxFillQuantity: '1',
          },
        ],
      },
      paperSyntheticSource,
    );
    await worker.run(controller.signal, (status) => report({ ...status }), ticks);
    report({ state: 'stopped' });
  } finally {
    process.removeListener('SIGINT', shutdown);
    process.removeListener('SIGTERM', shutdown);
    await database.close();
  }
}

main().catch(() => {
  console.error(JSON.stringify({ service: 'paper-worker-demo', code: 'PAPER_DEMO_FAILED', executionEnabled: false }));
  process.exitCode = 1;
});
