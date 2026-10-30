import { parseArgs } from 'node:util';
import { z } from 'zod';
import { paperModeSchema } from '@hth/contracts';
import { createDatabase } from '@hth/database';
import {
  localComposeEnvironment,
  dedicatedPaperDatabaseUrl,
  assertDedicatedPaperDatabase,
  migrateDedicatedPaperDatabase,
} from '@hth/database/testing';
import { initializeSyntheticPaper } from './paper-synthetic-account.js';
async function main() {
  paperModeSchema.parse(process.env.TRADING_MODE);
  Object.assign(process.env, localComposeEnvironment(process.env));
  const { values } = parseArgs({
    options: {
      account: { type: 'string' },
      initialize: { type: 'boolean', default: false },
      prepare: { type: 'boolean', default: false },
    },
  });
  if (!values.initialize) throw new Error('INITIALIZE_REQUIRED');
  const id = z
    .string()
    .regex(/^paper-demo-[A-Za-z0-9._:-]{1,80}$/)
    .parse(values.account);
  const local = process.env.LOCAL_CONTAINER_MODE === 'true' && process.env.NODE_ENV === 'production';
  const url = dedicatedPaperDatabaseUrl(process.env.PAPER_DEMO_DATABASE_URL, local);
  const db = createDatabase(url);
  try {
    await assertDedicatedPaperDatabase(db, url, local);
    if (values.prepare) await migrateDedicatedPaperDatabase(db, url, local);
    if (!(await initializeSyntheticPaper(db, id))) throw new Error('ACCOUNT_EXISTS');
    console.info(
      JSON.stringify({
        service: 'local-paper-prepare',
        state: 'initialized-still-stopped',
        source: 'synthetic-only',
        executionEnabled: false,
      }),
    );
  } finally {
    await db.close();
  }
}
main().catch(() => {
  console.error(
    JSON.stringify({
      service: 'local-paper-prepare',
      code: 'LOCAL_PAPER_INITIALIZATION_FAILED',
      executionEnabled: false,
    }),
  );
  process.exitCode = 1;
});
