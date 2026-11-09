import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Decimal } from 'decimal.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Market, PaperReviewCheckpoint } from '@hth/contracts';
import { contentHash, createDatabase } from '@hth/database';
import { migrateTestDatabase, testDatabaseUrl } from '@hth/database/testing';
import { marketTradingDate, movingAverageCross } from '@hth/trading';
import { verifyPaperContinuationBaseline, verifyPaperContinuationEvents } from './paper-continuation.js';
import { paperRehearsalPlanSchema } from './paper-rehearsal-plan.js';
import { rehearsalEvidence } from './paper-rehearsal-source.js';
import { paperReviewCheckpoint } from './paper-review.js';
import { createPaperWorker } from './paper-worker.js';

const plan = paperRehearsalPlanSchema.parse(
  JSON.parse(readFileSync(new URL('../../../examples/paper-rehearsal-plan.json', import.meta.url), 'utf8')),
);
const economicSnapshot = (snapshot: PaperReviewCheckpoint['snapshot']) => ({ ...snapshot, asOf: null });

// These are fabricated frames and internal Paper fills, never broker observations or orders.
// Only this test's fake source relabels rehearsal candle provenance to exercise toss-readonly guards.
describe.skipIf(!process.env.TEST_DATABASE_URL)('Paper continuation baseline / 전용 DB 합성 두 구간', () => {
  let db: ReturnType<typeof createDatabase>;
  let network: ReturnType<typeof vi.spyOn>;
  const workers: ReturnType<typeof createPaperWorker>[] = [];

  beforeAll(async () => {
    db = createDatabase(testDatabaseUrl());
    await migrateTestDatabase(db);
  }, 30000);
  beforeEach(() => {
    network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('NETWORK_FORBIDDEN'));
  });
  afterEach(async () => {
    try {
      await Promise.all(workers.splice(0).map((worker) => worker.close()));
      expect(network).not.toHaveBeenCalled();
    } finally {
      network.mockRestore();
    }
  });
  afterAll(async () => {
    await db?.close();
  });

  async function fixture(market: Market, manualTarget = false) {
    const profile = plan.profiles.find((entry) => entry.instrument.market === market)!;
    const account = 'paper-market-' + randomUUID();
    const currency: 'KRW' | 'USD' = market === 'KR' ? 'KRW' : 'USD';
    const manual = manualTarget ? profile.instrument : profile.manualInstrument;
    const clock = async () =>
      new Date(
        (await db.db.$client.query<{ now: string }>('SELECT clock_timestamp()::text AS now')).rows[0]!.now,
      ).toISOString();
    const anchor = await clock();
    const dailyPnl = {
      KRW: { tradingDate: marketTradingDate(Date.parse(anchor), 'KR'), netPnl: '-7' },
      USD: { tradingDate: marketTradingDate(Date.parse(anchor), 'US'), netPnl: '-0.07' },
    };
    await db.paper.createAccount(
      account,
      {
        observedAt: anchor,
        reconciled: false,
        cash: plan.cash,
        positions: [
          {
            instrument: manual,
            quantity: plan.manualQuantity,
            manualQuantity: plan.manualQuantity,
            sellableQuantity: plan.manualQuantity,
            ownership: [],
            markPrice: profile.flat[2],
            markTimestamp: anchor,
            markObservedAt: anchor,
          },
        ],
        dailyPnl,
      },
      'toss-readonly',
    );
    const version = await db.paper.configureLimits(account, 0, plan.limits);
    const strategy = {
      id: 'continuation-ma',
      instrument: profile.instrument,
      parameters: { fastPeriod: 1, slowPeriod: 2 },
      quantity: '2',
      maxFillQuantity: '1',
    };
    await db.paper.configureStrategy(account, version, {
      id: strategy.id,
      version: movingAverageCross.version,
      enabled: true,
      definition: {
        kind: 'moving-average-cross',
        instrument: strategy.instrument,
        parameters: strategy.parameters,
        quantity: strategy.quantity,
        maxFillQuantity: strategy.maxFillQuantity,
      },
    });
    let phase: 'bullish' | 'bearish' = 'bullish';
    const source = vi.fn(async (instruments: readonly { market: Market; symbol: string }[]) => {
      const now = await clock();
      return instruments.map((instrument) => {
        const target = instrument.market === market && instrument.symbol === profile.instrument.symbol;
        const evidence = rehearsalEvidence(instrument, target ? profile[phase] : profile.flat, now, anchor);
        return {
          ...evidence,
          marketData: {
            ...evidence.marketData,
            candles: evidence.marketData.candles.map((candle) => ({ ...candle, source: 'toss' })),
          },
        };
      });
    });
    const worker = (resume: boolean, baseline?: PaperReviewCheckpoint) => {
      const instance = createPaperWorker(
        {
          ...db.paper,
          acquireLease: (id, ttl, dataSource) =>
            db.paper.acquireLease(
              id,
              ttl,
              dataSource,
              baseline?.snapshot.version,
              baseline ? contentHash(baseline.snapshot.events) : undefined,
            ),
          resume: async (id, token, version) => {
            if (!baseline) return db.paper.resume(id, token, version);
            const current = await capture();
            const hash = verifyPaperContinuationEvents(baseline, current, 'before-resume');
            expect(current.snapshot.version).toBe(version);
            return db.paper.resume(id, token, version, hash);
          },
        },
        { accountId: account, resume, source: 'toss-readonly', strategies: [strategy] },
        source,
      );
      workers.push(instance);
      return instance;
    };
    const capture = async () => paperReviewCheckpoint(await db.paperReview.capture(account, 'toss-readonly'));
    return {
      account,
      profile,
      currency,
      dailyPnl,
      manual,
      source,
      worker,
      capture,
      setPhase(next: typeof phase) {
        phase = next;
      },
    };
  }

  async function inspectUnchanged(f: Awaited<ReturnType<typeof fixture>>, parent: PaperReviewCheckpoint) {
    const before = await db.paper.readAccount(f.account);
    const sourceCalls = f.source.mock.calls.length;
    const current = await f.capture();
    expect(economicSnapshot(current.snapshot)).toEqual(economicSnapshot(parent.snapshot));
    expect(verifyPaperContinuationBaseline(parent, current)).toEqual({
      baselineHash: parent.hash,
      checkedHash: current.hash,
      unchanged: true,
      executionEnabled: false,
      canResume: false,
    });
    expect(economicSnapshot((await f.capture()).snapshot)).toEqual(economicSnapshot(current.snapshot));
    expect(await db.paper.readAccount(f.account)).toEqual({ ...before, asOf: expect.any(String) });
    expect(f.source).toHaveBeenCalledTimes(sourceCalls);
  }

  it.each(['KR', 'US'] as const)('%s 정지 1회 관측은 지정된 준비 이력만 추가한다', async (market) => {
    const f = await fixture(market);
    const before = await f.capture();
    const stopped = f.worker(false);
    await stopped.start();
    await stopped.step();
    await stopped.close();
    const after = await f.capture();
    const prior = new Set(before.snapshot.events.map((event) => event.key));
    expect(
      after.snapshot.events
        .filter((event) => !prior.has(event.key))
        .map((event) => event.kind)
        .sort(),
    ).toEqual([
      'ACCOUNT_OBSERVED',
      'ACCOUNT_OBSERVED',
      'LEASE_ACQUIRED',
      'LEASE_RELEASED',
      'STRATEGY_DIAGNOSED',
      'WORKER_RECOVERED',
    ]);
    expect(verifyPaperContinuationEvents(before, after, 'stopped-observation')).toBe(
      contentHash(after.snapshot.events),
    );
    expect(after.snapshot.cash).toEqual(before.snapshot.cash);
    expect(after.snapshot.intents).toEqual([]);
    expect(after.snapshot.fills).toEqual([]);
    expect(after.snapshot.stopped).toBe(true);
  });

  it.each(['KR', 'US'] as const)('%s 매수 → 종료 → 읽기 점검 → 명시적 합성 재개 매도와 중복 방지', async (market) => {
    const f = await fixture(market);
    const first = f.worker(true);
    await first.start();
    for (let tick = 0; tick < 3; tick++) await first.step();
    await first.close();
    const parent = await f.capture();
    expect(parent.snapshot).toMatchObject({ source: 'toss-readonly', stopped: true, leasePresent: false });
    expect(parent.snapshot.reservations.every((reservation) => !reservation.active)).toBe(true);
    expect(parent.snapshot.intents).toMatchObject([{ side: 'BUY', state: 'FILLED', filledQuantity: '2' }]);
    expect(parent.snapshot.intents).toHaveLength(1);
    expect(parent.snapshot.fills).toHaveLength(2);
    expect(parent.snapshot.basis).toMatchObject([{ quantity: '2', amount: market === 'KR' ? '2203' : '22.03' }]);
    expect(
      parent.snapshot.positions.find((position) => position.instrument.symbol === f.profile.instrument.symbol),
    ).toMatchObject({ quantity: '2', manualQuantity: '0', ownership: [{ quantity: '2' }] });
    expect(new Decimal(parent.snapshot.dailyPnl[f.currency].netPnl).lt(f.dailyPnl[f.currency].netPnl)).toBe(true);
    await inspectUnchanged(f, parent);

    // Verification is read only and grants no resume; this separate test-owned worker opts in explicitly.
    const second = f.worker(true, parent);
    await second.start();
    const resumed = await f.capture();
    expect(resumed.snapshot.cash).toEqual(parent.snapshot.cash);
    expect(resumed.snapshot.dailyPnl).toEqual(parent.snapshot.dailyPnl);
    expect(resumed.snapshot.positions).toEqual(parent.snapshot.positions);
    expect(resumed.snapshot.basis).toEqual(parent.snapshot.basis);
    expect(resumed.snapshot.intents).toEqual(parent.snapshot.intents);
    expect(resumed.snapshot.fills).toEqual(parent.snapshot.fills);
    await second.step();
    expect((await f.capture()).snapshot.intents).toEqual(parent.snapshot.intents);
    f.setPhase('bearish');
    for (let tick = 0; tick < 3; tick++) await second.step();
    // Revisit the original bullish candle after liquidation: the permanent intent key blocks another buy.
    f.setPhase('bullish');
    await second.step();
    await second.close();
    const after = await f.capture();
    expect(after.snapshot.intents).toHaveLength(2);
    expect(after.snapshot.intents.filter((intent) => intent.side === 'BUY')).toEqual(parent.snapshot.intents);
    expect(after.snapshot.intents.find((intent) => intent.side === 'SELL')).toMatchObject({
      state: 'FILLED',
      filledQuantity: '2',
    });
    expect(after.snapshot.fills).toHaveLength(4);
    expect(new Set(after.snapshot.intents.map((intent) => intent.dedupeKey)).size).toBe(2);
    expect(
      after.snapshot.fills.filter((fill) => parent.snapshot.fills.some((prior) => prior.key === fill.key)),
    ).toEqual(parent.snapshot.fills);
    expect(after.snapshot.positions).toEqual([
      { instrument: f.manual, quantity: '3', manualQuantity: '3', sellableQuantity: '3', ownership: [] },
    ]);
    expect(after.snapshot.basis.every((basis) => basis.quantity === '0' && basis.amount === '0')).toBe(true);
    expect(after.snapshot.cash).toEqual({ ...plan.cash, [f.currency]: f.profile.expectedRoundTrip.cash });
    expect(
      after.snapshot.events.filter((event) => parent.snapshot.events.some((prior) => prior.key === event.key)),
    ).toEqual(parent.snapshot.events);
    expect(after.snapshot.dailyPnl).toEqual({
      ...f.dailyPnl,
      [f.currency]: {
        tradingDate: f.dailyPnl[f.currency].tradingDate,
        netPnl: new Decimal(f.dailyPnl[f.currency].netPnl).plus(f.profile.expectedRoundTrip.dailyPnl).toFixed(),
      },
    });
    expect(after.snapshot).toMatchObject({ stopped: true, leasePresent: false });
    expect(after.snapshot.reservations.every((reservation) => !reservation.active)).toBe(true);
  });

  it.each(['stop', 'limits-version'] as const)(
    '외부 %s 변경은 정지 상태와 경제 원장이 같아도 거부한다',
    async (change) => {
      const f = await fixture('US');
      const parent = await f.capture();
      await inspectUnchanged(f, parent);
      if (change === 'stop') await db.paper.stop(f.account, 'TEST_EXTERNAL_STOP');
      else await db.paper.configureLimits(f.account, parent.snapshot.version, plan.limits);
      const current = await f.capture();
      expect(current.snapshot.cash).toEqual(parent.snapshot.cash);
      expect(current.snapshot.dailyPnl).toEqual(parent.snapshot.dailyPnl);
      expect(current.snapshot.positions).toEqual(parent.snapshot.positions);
      expect(current.snapshot.stopped).toBe(true);
      expect(current.snapshot.version).toBeGreaterThan(parent.snapshot.version);
      expect(current.snapshot.epoch).toBeGreaterThan(parent.snapshot.epoch);
      expect(() => verifyPaperContinuationBaseline(parent, current)).toThrow('PAPER_CONTINUATION_INVALID');
      expect(economicSnapshot((await f.capture()).snapshot)).toEqual(economicSnapshot(current.snapshot));
      expect(f.source).not.toHaveBeenCalled();
    },
  );

  it.each(['KR', 'US'] as const)(
    '%s 같은 종목의 기존 수동 보유분은 두 구간에서 매수·매도에 사용하지 않는다',
    async (market) => {
      const f = await fixture(market, true);
      const first = f.worker(true);
      await first.start();
      await first.step();
      await first.close();
      const parent = await f.capture();
      expect(parent.snapshot.intents).toMatchObject([{ side: 'BUY', state: 'RISK_REJECTED' }]);
      expect(parent.snapshot.intents).toHaveLength(1);
      expect((await db.paper.readDashboard(f.account)).orders[0]?.codes).toContain('DUPLICATE_BUY');
      await inspectUnchanged(f, parent);
      f.setPhase('bearish');
      const second = f.worker(true);
      await second.start();
      await second.step();
      await second.close();
      const after = await f.capture();
      expect(after.snapshot.cash).toEqual(plan.cash);
      expect(after.snapshot.positions).toEqual(parent.snapshot.positions);
      expect(after.snapshot.positions).toEqual([
        { instrument: f.manual, quantity: '3', manualQuantity: '3', sellableQuantity: '3', ownership: [] },
      ]);
      expect(after.snapshot.intents).toEqual(parent.snapshot.intents);
      expect(after.snapshot.fills).toEqual([]);
      expect(after.snapshot.basis).toEqual([]);
      expect(after.snapshot).toMatchObject({ stopped: true, leasePresent: false });
    },
  );
});
