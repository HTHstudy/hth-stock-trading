import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createDatabase, contentHash } from '@hth/database';
import { migrateTestDatabase } from '@hth/database/testing';
import { parsePaperRehearsalConfig, paperRehearsalPlanSchema } from './paper-rehearsal-plan.js';
import type { PaperRehearsalPlan } from './paper-rehearsal-plan.js';
import { rehearsePaper } from './paper-rehearsal.js';
import type { RehearsalCheck } from './paper-rehearsal.js';
async function main() {
  const config = parsePaperRehearsalConfig(process.argv.slice(2), process.env);
  const file = await open(config.planPath, constants.O_RDONLY | constants.O_NONBLOCK);
  let plan: PaperRehearsalPlan;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 65536) throw new Error('PAPER_REHEARSAL_CONFIGURATION_INVALID');
    const buffer = Buffer.alloc(65537);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 65536) throw new Error('PAPER_REHEARSAL_CONFIGURATION_INVALID');
    plan = paperRehearsalPlanSchema.parse(JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')));
  } finally {
    await file.close();
  }
  const planHash = contentHash(plan);
  if (!config.execute) {
    console.info(
      JSON.stringify({ service: 'paper-rehearsal', state: 'preview', executionEnabled: false, planHash, plan }),
    );
    return;
  }
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const directory = join(config.output, runId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const database = createDatabase(config.databaseUrl!);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const checks: RehearsalCheck[] = [];
  async function save(value: Record<string, unknown>) {
    await writeFile(
      join(directory, 'report.json.tmp'),
      JSON.stringify(
        {
          formatVersion: 'paper-rehearsal-result-v1',
          runId,
          startedAt,
          finishedAt: new Date().toISOString(),
          mode: 'paper',
          source: 'synthetic-only',
          executionEnabled: false,
          planHash,
          plan,
          ...value,
        },
        null,
        2,
      ) + '\n',
      { flag: 'wx', mode: 0o600 },
    );
    await rename(join(directory, 'report.json.tmp'), join(directory, 'report.json'));
  }
  try {
    if (config.prepare) await migrateTestDatabase(database, config.databaseUrl!);
    const result = await rehearsePaper(database, plan, controller.signal, (value) => {
      checks.push(value);
    });
    await save({ status: 'passed', result });
    console.info(
      JSON.stringify({
        service: 'paper-rehearsal',
        runId,
        state: 'passed',
        checks: checks.length,
        planHash,
        semanticHash: result.semanticHash,
        executionEnabled: false,
      }),
    );
  } catch (error) {
    const code = controller.signal.aborted
      ? 'CANCELLED'
      : error instanceof Error &&
          ['PAPER_REHEARSAL_ASSERTION_FAILED', 'UNSAFE_TEST_DATABASE', 'PAPER_REHEARSAL_DAY_CHANGED'].includes(
            error.message,
          )
        ? error.message
        : 'PAPER_REHEARSAL_FAILED';
    await save({ status: controller.signal.aborted ? 'cancelled' : 'failed', code, checks });
    console.error(JSON.stringify({ service: 'paper-rehearsal', runId, code, executionEnabled: false }));
    process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await database.close();
  }
}
main().catch(() => {
  console.error(
    JSON.stringify({
      service: 'paper-rehearsal',
      code: 'PAPER_REHEARSAL_CONFIGURATION_OR_STORAGE_FAILED',
      executionEnabled: false,
    }),
  );
  process.exitCode = 1;
});
