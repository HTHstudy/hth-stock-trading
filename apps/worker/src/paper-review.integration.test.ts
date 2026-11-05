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
describe.skipIf(!process.env.TEST_DATABASE_URL)('Paper capture → 합성 체결 → 비교 통합', () => {
  let db: ReturnType<typeof createDatabase>;
  beforeAll(async () => {
    db = createDatabase(testDatabaseUrl());
    await migrateTestDatabase(db);
  }, 30000);
  afterAll(async () => {
    await db?.close();
  });
  it.each([
    ['KR', 'partial'],
    ['US', 'partial'],
    ['KR', 'round-trip'],
    ['US', 'round-trip'],
  ] as const)('%s %s 원장의 전후 증거를 파일로 비교하고 원장을 변경하지 않는다', async (market, scenario) => {
    const directory = await mkdtemp(join(tmpdir(), 'paper-review-db-'));
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('NETWORK_FORBIDDEN'));
    const profile = plan.profiles.find((p) => p.instrument.market === market)!;
    const account = 'paper-demo-' + randomUUID();
    const currency = market === 'KR' ? 'KRW' : 'USD';
    let phase: 'bullish' | 'bearish' = 'bullish';
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
          positions:
            scenario === 'round-trip'
              ? [
                  {
                    instrument: profile.manualInstrument,
                    quantity: plan.manualQuantity,
                    manualQuantity: plan.manualQuantity,
                    sellableQuantity: plan.manualQuantity,
                    ownership: [],
                    markPrice: profile.flat[2],
                    markTimestamp: anchor,
                    markObservedAt: anchor,
                  },
                ]
              : [],
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
          return instruments.map((instrument) =>
            rehearsalEvidence(
              instrument,
              instrument.symbol === profile.instrument.symbol ? profile[phase] : profile.flat,
              now,
              anchor,
            ),
          );
        },
      );
      await worker.start();
      await worker.step();
      await worker.step();
      if (scenario === 'round-trip') {
        const partialBuy = await db.paperReview.capture(account, 'synthetic-only');
        expect(partialBuy.intents[0]).toMatchObject({ state: 'PARTIALLY_FILLED', filledQuantity: '1' });
        expect(partialBuy.basis).toMatchObject([{ quantity: '1', amount: market === 'KR' ? '1102' : '11.02' }]);
        await worker.step();
        const fullBuy = await db.paperReview.capture(account, 'synthetic-only');
        expect(fullBuy.basis).toMatchObject([{ quantity: '2', amount: market === 'KR' ? '2203' : '22.03' }]);
        phase = 'bearish';
        await worker.step();
        await worker.step();
        expect((await db.paper.readDashboard(account)).orders.find((order) => order.side === 'SELL')).toMatchObject({
          state: 'PARTIALLY_FILLED',
          filledQuantity: '1',
        });
        const partialSell = await db.paperReview.capture(account, 'synthetic-only');
        expect(partialSell.basis).toMatchObject([{ quantity: '1', amount: market === 'KR' ? '1102' : '11.02' }]);
        await worker.step();
      }
      await worker.close();
      const beforeRead = await db.paper.readDashboard(account);
      if (scenario === 'partial') {
        expect(beforeRead.orders[0]).toMatchObject({ state: 'ABORTED', filledQuantity: '1' });
      } else {
        expect(beforeRead.orders).toHaveLength(2);
        expect(beforeRead.orders.every((order) => order.state === 'FILLED' && order.filledQuantity === '2')).toBe(true);
        expect(beforeRead.fills).toHaveLength(4);
        expect(beforeRead.portfolios.find((value) => value.currency === currency)).toMatchObject(
          profile.expectedRoundTrip,
        );
        expect(beforeRead.positions).toHaveLength(1);
        expect(beforeRead.positions[0]).toMatchObject({
          instrument: profile.manualInstrument,
          quantity: '3',
          manualQuantity: '3',
        });
      }
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
        evidence: { newIntents: scenario === 'partial' ? 1 : 2, newFills: scenario === 'partial' ? 1 : 4 },
      });
      if (scenario === 'round-trip') {
        expect(artifact.report.comparison).toMatchObject({
          cashBefore: plan.cash,
          cashAfter: { ...plan.cash, [currency]: profile.expectedRoundTrip.cash },
          costs: market === 'KR' ? { KRW: '9', USD: '0' } : { KRW: '0', USD: '0.09' },
          realizedPnl: market === 'KR' ? { KRW: '-409', USD: '0' } : { KRW: '0', USD: '-4.09' },
          basisBefore: [],
        });
        const chronological = [...checkpoint.snapshot.fills].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        expect(chronological.map(({ quantity, costs, realizedPnl }) => ({ quantity, costs, realizedPnl }))).toEqual(
          (market === 'KR'
            ? [
                ['2', '0'],
                ['1', '0'],
                ['3', '-204'],
                ['3', '-205'],
              ]
            : [
                ['0.02', '0'],
                ['0.01', '0'],
                ['0.03', '-2.04'],
                ['0.03', '-2.05'],
              ]
          ).map(([costs, realizedPnl]) => ({ quantity: '1', costs, realizedPnl })),
        );
        expect(checkpoint.snapshot.positions).toEqual([
          {
            instrument: profile.manualInstrument,
            quantity: '3',
            manualQuantity: '3',
            sellableQuantity: '3',
            ownership: [],
          },
        ]);
        expect(checkpoint.snapshot.basis.every((basis) => basis.quantity === '0' && basis.amount === '0')).toBe(true);
        expect(checkpoint.snapshot.stopped).toBe(true);
        expect(checkpoint.snapshot.leasePresent).toBe(false);
        expect(checkpoint.snapshot.reservations.every((reservation) => !reservation.active)).toBe(true);
      }
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
