import { parseArgs } from 'node:util';
import { z } from 'zod';
import { createDatabase, contentHash } from '@hth/database';
import { assertDedicatedPaperDatabase, dedicatedPaperDatabaseUrl } from '@hth/database/testing';
import { paperStrategyDefinitionSchema, paperModeSchema } from '@hth/contracts';
import { movingAverageCross } from '@hth/trading';
import { createPaperWorker } from './paper-worker.js';
import { createPaperSyntheticSource } from './paper-synthetic-source.js';

async function main() {
  paperModeSchema.parse(process.env.TRADING_MODE);
  const { values } = parseArgs({ options: { account: { type: 'string' } } });
  const id = z
    .string()
    .regex(/^paper-demo-[A-Za-z0-9._:-]{1,80}$/)
    .parse(values.account);
  const local = process.env.LOCAL_CONTAINER_MODE === 'true' && process.env.NODE_ENV === 'production';
  const url = dedicatedPaperDatabaseUrl(process.env.PAPER_DEMO_DATABASE_URL, local);
  const database = createDatabase(url);
  const stop = new AbortController();
  const abort = () => stop.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    await assertDedicatedPaperDatabase(database, url, local);
    const account = await database.paper.readAccount(id);
    if (account.source !== 'synthetic-only') throw new Error('PAPER_SOURCE_MISMATCH');
    const stored = await database.paper.readStrategies(id);
    if (!stored.length || stored.length > 5) throw new Error('PAPER_STRATEGIES_INVALID');
    const strategies = stored.map((item) => {
      const definition = paperStrategyDefinitionSchema.parse(item.definition);
      if (
        item.version !== movingAverageCross.version ||
        item.definitionHash !== contentHash({ version: item.version, definition }) ||
        definition.instrument.market !== 'KR' ||
        definition.parameters.slowPeriod >= 200
      )
        throw new Error('PAPER_STRATEGIES_INVALID');
      return {
        id: item.id,
        instrument: definition.instrument,
        parameters: definition.parameters,
        quantity: definition.quantity,
        maxFillQuantity: definition.maxFillQuantity,
      };
    });
    const worker = createPaperWorker(
      database.paper,
      { accountId: id, source: 'synthetic-only', resume: false, intervalMs: 10000, strategies },
      createPaperSyntheticSource(Math.max(3, ...strategies.map((s) => s.parameters.slowPeriod + 1))),
    );
    await worker.run(stop.signal, (status) =>
      console.info(JSON.stringify({ service: 'paper-service', source: 'synthetic-only', ...status })),
    );
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
    await database.close();
  }
}
main().catch((error: unknown) => {
  if (error instanceof Error && error.message === 'PAPER_CONTROL_CHANGED') {
    console.info(JSON.stringify({ service: 'paper-service', state: 'stopped', executionEnabled: false }));
    return;
  }
  console.error(JSON.stringify({ service: 'paper-service', code: 'PAPER_SERVICE_FAILED', executionEnabled: false }));
  process.exitCode = 1;
});
