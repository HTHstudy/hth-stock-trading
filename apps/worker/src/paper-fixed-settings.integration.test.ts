import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Decimal } from 'decimal.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Market } from '@hth/contracts';
import { contentHash, createDatabase } from '@hth/database';
import { migrateTestDatabase, testDatabaseUrl } from '@hth/database/testing';
import { assessCandle, marketTradingDate } from '@hth/trading';
import { paperMarketPlanSchema } from './paper-market-plan.js';
import { createPaperWorker } from './paper-worker.js';
import { rehearsalEvidence } from './paper-rehearsal-source.js';

// Fixed public validation settings with independent fabricated market frames.
// This exercises execution/recovery, not historical replay or actual Toss observations.
describe.skipIf(!process.env.TEST_DATABASE_URL)('고정 MA 5/20·1주 설정의 원장/장애 복구', () => {
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

  async function fixture(market: Market) {
    const plan = paperMarketPlanSchema.parse(
      JSON.parse(
        readFileSync(
          new URL(`../../../examples/paper-market-${market.toLowerCase()}-validation-v1.json`, import.meta.url),
          'utf8',
        ),
      ),
    );
    const id = 'paper-market-' + randomUUID(),
      currency: 'KRW' | 'USD' = market === 'KR' ? 'KRW' : 'USD';
    const base = market === 'KR' ? new Decimal(10000) : new Decimal(100);
    await db.paperPreparation.create({
      accountId: id,
      planHash: contentHash(plan),
      cash: plan.cash,
      limits: plan.limits,
      strategyVersion: plan.strategyVersion,
      strategy: plan.strategy,
    });
    const clock = async () =>
      new Date(
        (await db.db.$client.query<{ now: string }>('SELECT clock_timestamp()::text AS now')).rows[0]!.now,
      ).toISOString();
    const anchor = await clock();
    let phase: 'buy' | 'sell' = 'buy',
      fail = false;
    const source = vi.fn(async () => {
      if (fail) throw new Error('FIXTURE_SOURCE_FAILURE');
      const asOf = await clock(),
        instrument = plan.strategy.instrument;
      const quote = base.mul(phase === 'buy' ? '1.005' : '0.995').toFixed();
      const seed = rehearsalEvidence(instrument, [base.toFixed(), base.toFixed(), quote], asOf, anchor);
      const last = seed.marketData.candles.at(-1)!;
      const candidates = [];
      for (let offset = 0; offset < 240 && candidates.length < 21; offset++) {
        const timestamp = new Date(Date.parse(last.timestamp) - offset * 60000).toISOString();
        const candle = {
          ...last,
          timestamp,
          tradingDate: marketTradingDate(Date.parse(timestamp) - 1, market),
          source: 'toss',
          isClosed: false,
        };
        const day =
          [
            seed.marketData.calendar!.previousBusinessDay,
            seed.marketData.calendar!.today,
            seed.marketData.calendar!.nextBusinessDay,
          ].find((day) => day?.tradingDate === candle.tradingDate) ?? null;
        if (
          assessCandle(candle, { asOf: anchor, observedAt: anchor, day, nxtSupported: seed.marketData.nxtSupported })
            .status === 'closed'
        )
          candidates.push(candle);
      }
      expect(candidates).toHaveLength(21);
      const candles = candidates.reverse().map((candle, index) => {
        const price =
          index === 20 ? quote : index < 15 ? base.toFixed() : base.mul(phase === 'buy' ? '0.999' : '1.001').toFixed();
        return { ...candle, open: price, high: price, low: price, close: price };
      });
      return [{ ...seed, quote: { ...seed.quote, price: quote }, marketData: { ...seed.marketData, candles } }];
    });
    const create = (resume: boolean) => {
      const worker = createPaperWorker(
        db.paper,
        {
          accountId: id,
          source: 'toss-readonly',
          resume,
          strategies: [
            {
              id: 'market-ma',
              instrument: plan.strategy.instrument,
              parameters: plan.strategy.parameters,
              quantity: plan.strategy.quantity,
              maxFillQuantity: plan.strategy.maxFillQuantity,
            },
          ],
        },
        source,
      );
      workers.push(worker);
      return worker;
    };
    const capture = () => db.paperReview.capture(id, 'toss-readonly');
    expect(plan.strategy.parameters).toEqual({ fastPeriod: 5, slowPeriod: 20 });
    expect(plan.strategy.quantity).toBe('1');
    expect(plan.strategy.maxFillQuantity).toBe('1');
    return {
      id,
      plan,
      currency,
      base,
      source,
      create,
      capture,
      setPhase(value: typeof phase) {
        phase = value;
      },
      setFailure(value: boolean) {
        fail = value;
      },
    };
  }
  function clean(snapshot: Awaited<ReturnType<ReturnType<typeof createDatabase>['paperReview']['capture']>>) {
    expect(snapshot).toMatchObject({ stopped: true, leasePresent: false });
    expect(snapshot.reservations.every((item) => !item.active)).toBe(true);
    expect(
      snapshot.intents.every((item) => !['INTENT_RECORDED', 'READY', 'PARTIALLY_FILLED'].includes(item.state)),
    ).toBe(true);
  }
  it.each(['KR', 'US'] as const)('%s 고정 설정으로 다음 quote 체결·매도·비용·중복 키를 검증한다', async (market) => {
    const f = await fixture(market),
      worker = f.create(true);
    await worker.start();
    expect(await worker.step()).toMatchObject({ signals: 1, fills: 0 });
    const reserved = await f.capture();
    expect(reserved.intents).toMatchObject([{ side: 'BUY', state: 'READY', quantity: '1', filledQuantity: '0' }]);
    expect(reserved.fills).toEqual([]);
    expect(await worker.step()).toMatchObject({ signals: 0, fills: 1 });
    const bought = await f.capture();
    expect(bought.fills).toHaveLength(1);
    expect(bought.positions).toMatchObject([{ quantity: '1', manualQuantity: '0', ownership: [{ quantity: '1' }] }]);
    expect(bought.basis[0]?.amount).toBe(market === 'KR' ? '10061' : '100.61');
    expect(new Decimal(bought.cash[f.currency]).add(bought.basis[0]!.amount).eq(f.plan.cash[f.currency])).toBe(true);
    const buyKey = bought.intents[0]!.dedupeKey;
    f.setPhase('sell');
    expect(await worker.step()).toMatchObject({ signals: 1, fills: 0 });
    expect(await worker.step()).toMatchObject({ signals: 0, fills: 1 });
    f.setPhase('buy');
    await worker.step();
    await worker.close();
    const after = await f.capture();
    clean(after);
    expect(after.fills).toHaveLength(2);
    expect(after.intents).toHaveLength(2);
    expect(after.intents.map((item) => ({ side: item.side, quantity: item.quantity, state: item.state }))).toEqual(
      expect.arrayContaining([
        { side: 'BUY', quantity: '1', state: 'FILLED' },
        { side: 'SELL', quantity: '1', state: 'FILLED' },
      ]),
    );
    expect(after.intents.find((item) => item.side === 'BUY')?.dedupeKey).toBe(buyKey);
    expect(after.basis).toHaveLength(1);
    expect(after.basis[0]).toMatchObject({ quantity: '0', amount: '0' });
    expect(after.positions.every((item) => new Decimal(item.quantity).isZero())).toBe(true);
    expect(after.cash[f.currency]).toBe(market === 'KR' ? '999859' : '998.59');
    expect(after.dailyPnl[f.currency].netPnl).toBe(market === 'KR' ? '-141' : '-1.41');
    expect((await db.paper.readStrategies(f.id))[0]!.definition).toEqual(f.plan.strategy);
  });
  it.each(['KR', 'US'] as const)(
    '%s 예약 직후 수집 실패는 미체결만 중단하고 기본 복구에서 재매수하지 않는다',
    async (market) => {
      const f = await fixture(market),
        worker = f.create(true);
      await worker.start();
      await worker.step();
      const before = await f.capture();
      expect(before.intents[0]?.state).toBe('READY');
      f.setFailure(true);
      await expect(worker.step()).rejects.toThrow('FIXTURE_SOURCE_FAILURE');
      const stopped = await f.capture();
      clean(stopped);
      expect(stopped.intents[0]?.state).toBe('ABORTED');
      expect(stopped.fills).toEqual([]);
      expect(stopped.cash).toEqual(f.plan.cash);
      expect(stopped.basis).toEqual([]);
      f.setFailure(false);
      const recovery = f.create(false);
      await recovery.start();
      expect(await recovery.step()).toMatchObject({ state: 'paused', signals: 0, fills: 0 });
      await recovery.close();
      const after = await f.capture();
      clean(after);
      expect(after.cash).toEqual(stopped.cash);
      expect(after.intents).toEqual(stopped.intents);
      expect(after.fills).toEqual([]);
      const explicit = f.create(true);
      await explicit.start();
      await explicit.step();
      await explicit.close();
      const resumed = await f.capture();
      clean(resumed);
      expect(resumed.intents).toEqual(stopped.intents);
      expect(resumed.cash).toEqual(stopped.cash);
      expect(resumed.fills).toEqual([]);
      expect(JSON.stringify(await db.paper.readDiagnostics(f.id))).not.toContain('FIXTURE_SOURCE_FAILURE');
    },
  );
  it.each(['KR', 'US'] as const)('%s 매수 체결 뒤 장애·기본 복구는 소유권·원가·손실을 보존한다', async (market) => {
    const f = await fixture(market),
      worker = f.create(true);
    await worker.start();
    await worker.step();
    await worker.step();
    const bought = await f.capture();
    expect(bought.fills).toHaveLength(1);
    f.setFailure(true);
    await expect(worker.step()).rejects.toThrow('FIXTURE_SOURCE_FAILURE');
    const stopped = await f.capture();
    clean(stopped);
    expect(stopped.basis).toEqual(bought.basis);
    expect(stopped.positions).toEqual(bought.positions);
    expect(stopped.cash).toEqual(bought.cash);
    expect(stopped.dailyPnl).toEqual(bought.dailyPnl);
    f.setFailure(false);
    const recovery = f.create(false);
    await recovery.start();
    await recovery.step();
    await recovery.close();
    const after = await f.capture();
    clean(after);
    expect(after.basis).toEqual(stopped.basis);
    expect(after.positions).toEqual(stopped.positions);
    expect(after.cash).toEqual(stopped.cash);
    expect(after.dailyPnl).toEqual(stopped.dailyPnl);
    expect(after.intents).toEqual(stopped.intents);
    expect(after.fills).toEqual(stopped.fills);
    const explicit = f.create(true);
    await explicit.start();
    await explicit.step();
    expect((await f.capture()).intents).toEqual(stopped.intents);
    f.setPhase('sell');
    await explicit.step();
    await explicit.step();
    await explicit.close();
    const liquidated = await f.capture();
    clean(liquidated);
    expect(liquidated.fills).toHaveLength(2);
    expect(liquidated.intents).toHaveLength(2);
    expect(liquidated.basis[0]).toMatchObject({ quantity: '0', amount: '0' });
    expect(liquidated.cash[f.currency]).toBe(market === 'KR' ? '999859' : '998.59');
    expect(liquidated.dailyPnl[f.currency].netPnl).toBe(market === 'KR' ? '-141' : '-1.41');
  });
});
