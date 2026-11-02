import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDatabase, contentHash } from '@hth/database';
import { migrateTestDatabase, testDatabaseUrl } from '@hth/database/testing';
import { movingAverageCross, marketTradingDate } from '@hth/trading';
import { paperReviewArtifactSchema, paperReviewCheckpointSchema } from '@hth/contracts';
import { paperRehearsalPlanSchema } from './paper-rehearsal-plan.js';
import { rehearsalEvidence } from './paper-rehearsal-source.js';
import { createPaperWorker } from './paper-worker.js';
import { runPaperReview } from './paper-review-runtime.js';

const plan = paperRehearsalPlanSchema.parse(
  JSON.parse(readFileSync(new URL('../../../examples/paper-rehearsal-plan.json', import.meta.url), 'utf8')),
);
describe.skipIf(!process.env.TEST_DATABASE_URL)('Paper capture → 합성 부분 체결 → 비교 통합', () => {
  let db: ReturnType<typeof createDatabase>;
  beforeAll(async () => {
    db = createDatabase(testDatabaseUrl());
    await migrateTestDatabase(db);
  }, 30000);
  afterAll(async () => {
    await db?.close();
  });
  it.each(['KR', 'US'] as const)('%s 원장의 전후 증거를 파일로 비교하고 원장을 변경하지 않는다', async (market) => {
    const directory = await mkdtemp(join(tmpdir(), 'paper-review-db-'));
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('NETWORK_FORBIDDEN'));
    const profile = plan.profiles.find((p) => p.instrument.market === market)!;
    const account = 'paper-demo-' + randomUUID();
    const clock = async () =>
      new Date(
        (await db.db.$client.query<{ now: string }>('SELECT clock_timestamp()::text AS now')).rows[0]!.now,
      ).toISOString();
    const anchor = await clock();
    let worker: ReturnType<typeof createPaperWorker> | undefined;
    try {
      await db.paper.createAccount(
        account,
        {
          observedAt: anchor,
          reconciled: false,
          cash: plan.cash,
          positions: [],
          dailyPnl: {
            KRW: { tradingDate: marketTradingDate(Date.parse(anchor), 'KR'), netPnl: '0' },
            USD: { tradingDate: marketTradingDate(Date.parse(anchor), 'US'), netPnl: '0' },
          },
        },
        'synthetic-only',
      );
      const version = await db.paper.configureLimits(account, 0, plan.limits);
      await db.paper.configureStrategy(account, version, {
        id: 'review-ma',
        version: movingAverageCross.version,
        enabled: true,
        definition: {
          kind: 'moving-average-cross',
          instrument: profile.instrument,
          parameters: { fastPeriod: 1, slowPeriod: 2 },
          quantity: '2',
          maxFillQuantity: '1',
        },
      });
      const env = { PAPER_DEMO_DATABASE_URL: testDatabaseUrl() };
      const beforePath = join(directory, 'before.json'),
        afterPath = join(directory, 'after.json'),
        output = join(directory, 'report.json');
      const capture = (path: string) =>
        runPaperReview(['--capture', '--kind=synthetic', '--account=' + account, '--output=' + path], env);
      await capture(beforePath);
      worker = createPaperWorker(
        db.paper,
        {
          accountId: account,
          resume: true,
          strategies: [
            {
              id: 'review-ma',
              instrument: profile.instrument,
              parameters: { fastPeriod: 1, slowPeriod: 2 },
              quantity: '2',
              maxFillQuantity: '1',
            },
          ],
        },
        async (instruments) => {
          const now = await clock();
          return instruments.map((instrument) => rehearsalEvidence(instrument, profile.bullish, now, anchor));
        },
      );
      await worker.start();
      await worker.step();
      await worker.step();
      await worker.close();
      const beforeRead = await db.paper.readDashboard(account);
      expect(beforeRead.orders[0]).toMatchObject({ state: 'ABORTED', filledQuantity: '1' });
      await capture(afterPath);
      const result = await runPaperReview(
        ['--compare', '--before=' + beforePath, '--after=' + afterPath, '--output=' + output],
        {},
      );
      expect(result).toMatchObject({ verdict: 'consistent-observed-state', canResume: false, executionEnabled: false });
      const artifact = paperReviewArtifactSchema.parse(JSON.parse(await readFile(output, 'utf8')));
      const checkpoint = paperReviewCheckpointSchema.parse(JSON.parse(await readFile(afterPath, 'utf8')));
      expect(artifact.hash).toBe(contentHash(artifact.report));
      expect(checkpoint.hash).toBe(contentHash(checkpoint.snapshot));
      expect(artifact.report).toMatchObject({
        checks: { costBasisReplay: 'passed', cashMatchesFills: 'passed', manualHoldingsPreserved: 'passed' },
        evidence: { newIntents: 1, newFills: 1 },
      });
      expect(await db.paper.readDashboard(account)).toEqual({ ...beforeRead, asOf: expect.any(String) });
      expect(await readFile(output, 'utf8')).not.toContain(account);
      expect(network).not.toHaveBeenCalled();
    } finally {
      await worker?.close();
      network.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
