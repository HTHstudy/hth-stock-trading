import { parseArgs } from 'node:util';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import { paperModeSchema } from '@hth/contracts';
import { createDatabase } from '@hth/database';
import { testDatabaseUrl } from '@hth/database/testing';
import { createTossReadonlyBroker } from '@hth/broker/toss';
import { BrokerError } from '@hth/broker';
import { parsePaperMarketConfig } from './paper-market-config.js';
import { applyPaperDayReview, planPaperDayReview, paperDayReviewPlanSchema } from './paper-day-review.js';

async function main() {
  paperModeSchema.parse(process.env.TRADING_MODE);
  const { values } = parseArgs({
    options: {
      account: { type: 'string' },
      output: { type: 'string' },
      apply: { type: 'string' },
      acknowledge: { type: 'string' },
    },
  });
  if (Boolean(values.output) === Boolean(values.apply) || (values.output && values.acknowledge))
    throw new Error('PAPER_REVIEW_FLAGS_INVALID');
  const id = z
    .string()
    .regex(/^paper-market-[A-Za-z0-9._:-]{1,70}$/)
    .parse(values.account);
  const url = testDatabaseUrl(process.env.PAPER_MARKET_DATABASE_URL ?? '');
  const target = new URL(url);
  if (!['postgres:', 'postgresql:'].includes(target.protocol) || target.search || target.hash)
    throw new Error('PAPER_REVIEW_CONFIGURATION_INVALID');
  const database = createDatabase(url);
  let brokerDatabase: ReturnType<typeof createDatabase> | undefined;
  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    if (values.output) {
      const plan = await planPaperDayReview(database.paper, id);
      await writeFile(values.output, `${JSON.stringify(plan, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    } else {
      if (values.acknowledge !== 'CARRY_FORWARD_PAPER_LOSSES') throw new Error('PAPER_REVIEW_ACKNOWLEDGEMENT_REQUIRED');
      if ((await stat(values.apply!)).size > 64000) throw new Error('PAPER_REVIEW_FILE_INVALID');
      const plan = paperDayReviewPlanSchema.parse(JSON.parse(await readFile(values.apply!, 'utf8')));
      if (plan.accountId !== id) throw new Error('PAPER_REVIEW_ACCOUNT_MISMATCH');
      const config = parsePaperMarketConfig([`--account=${id}`], process.env);
      brokerDatabase = createDatabase(config.brokerUrl!);
      await applyPaperDayReview(
        {
          paper: database.paper,
          clientId: config.clientId!,
          withBrokerLease: (key, operation) => brokerDatabase!.withBrokerLease(key, operation),
          createBroker: (signal) =>
            createTossReadonlyBroker({ clientId: config.clientId!, clientSecret: config.clientSecret!, signal }),
        },
        plan,
        values.acknowledge,
        shutdown.signal,
      );
    }
    console.info(
      JSON.stringify({
        service: 'paper-day-review',
        state: values.output ? 'plan-written' : 'reviewed-still-stopped',
        executionEnabled: false,
      }),
    );
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await Promise.all([database.close(), brokerDatabase?.close()]);
  }
}
main().catch((error: unknown) => {
  const known = new Set([
    'PAPER_REVIEW_FLAGS_INVALID',
    'PAPER_REVIEW_ACKNOWLEDGEMENT_REQUIRED',
    'PAPER_REVIEW_EXPIRED',
    'PAPER_REVIEW_CONFLICT',
    'PAPER_VERSION_CONFLICT',
    'PAPER_REVIEW_REQUIRES_STOP',
    'PAPER_TRADING_DAY_REVIEW_REQUIRED',
    'PAPER_TRADING_DAY_REVIEW_NOT_REQUIRED',
    'PAPER_TRADING_DAY_REVIEW_INVALID',
    'PAPER_RECOVERY_PENDING',
    'PAPER_OBSERVATION_STALE',
    'BROKER_LEASE_BUSY',
    'BROKER_LEASE_LOST',
  ]);
  const code =
    error instanceof BrokerError
      ? error.code
      : error instanceof Error && known.has(error.message)
        ? error.message
        : 'PAPER_DAY_REVIEW_FAILED';
  console.error(JSON.stringify({ service: 'paper-day-review', code, executionEnabled: false }));
  process.exitCode = 1;
});
