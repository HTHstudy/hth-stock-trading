import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDatabase } from '@hth/database';
import { migrateTestDatabase, testDatabaseUrl } from '@hth/database/testing';
import { marketTradingDate, movingAverageCross } from '@hth/trading';
import type { PaperEvidence } from '@hth/contracts';
import { createPaperWorker } from './paper-worker.js';
import type { PaperSource } from './paper-worker.js';
import { paperSyntheticSource } from './paper-synthetic-source.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('Paper 상시 worker', () => {
  let database: ReturnType<typeof createDatabase>;
  const workers: ReturnType<typeof createPaperWorker>[] = [];
  beforeAll(async () => {
    database = createDatabase(testDatabaseUrl());
    await migrateTestDatabase(database);
  }, 30_000);
  afterAll(async () => {
    await Promise.all(workers.map((worker) => worker.close().catch(() => {})));
    await database?.close();
  });
  async function fixture(resume = true) {
    const id = `worker-${randomUUID()}`;
    const now = new Date().toISOString();
    await database.paper.createAccount(
      id,
      {
        observedAt: now,
        reconciled: false,
        cash: { KRW: '15000', USD: '1000' },
        positions: [],
        dailyPnl: {
          KRW: { tradingDate: marketTradingDate(Date.parse(now), 'KR'), netPnl: '0' },
          USD: { tradingDate: marketTradingDate(Date.parse(now), 'US'), netPnl: '0' },
        },
      },
      'synthetic-only',
    );
    const currency = {
      maxOrderAmount: '100000',
      maxInstrumentAmount: '200000',
      maxDailyLoss: '10000',
      buyCostBps: '10',
      sellCostBps: '30',
    };
    const version = await database.paper.configureLimits(id, 0, { KRW: currency, USD: currency, maxPositions: 5 });
    await database.paper.configureStrategy(id, version, {
      id: 'test-ma',
      version: movingAverageCross.version,
      enabled: true,
    });
    const config = {
      accountId: id,
      resume,
      intervalMs: 100,
      sourceTimeoutMs: 5000,
      strategies: [
        {
          id: 'test-ma',
          instrument: { market: 'KR', symbol: '005930' },
          parameters: { fastPeriod: 1, slowPeriod: 2 },
          quantity: '2',
          maxFillQuantity: '1',
        },
      ],
    };
    let bearish = false;
    let failed = false;
    let stalled = false;
    const source: PaperSource = async (instruments, signal) => {
      if (failed) throw new Error('RAW_SOURCE_ERROR_DO_NOT_LOG');
      if (stalled) return new Promise(() => {});
      const evidence = (await paperSyntheticSource(instruments, signal)) as PaperEvidence[];
      for (const entry of evidence) {
        const prices = bearish ? ['1000', '1100', '900'] : ['1000', '900', '1100'];
        entry.marketData.candles.forEach((candle, index) =>
          Object.assign(candle, { open: prices[index], high: prices[index], low: prices[index], close: prices[index] }),
        );
        entry.quote.price = prices[2]!;
      }
      return evidence;
    };
    const create = (next = config, feed = source) => {
      const worker = createPaperWorker(database.paper, next, feed);
      workers.push(worker);
      return worker;
    };
    return {
      id,
      config,
      source,
      worker: create(),
      create,
      bearish: () => {
        bearish = true;
      },
      fail: () => {
        failed = true;
      },
      stall: () => {
        stalled = true;
      },
    };
  }
  it('명시적 재개 없이는 관측만 하고 의도나 체결을 생성하지 않는다', async () => {
    const context = await fixture(false);
    await context.worker.start();
    expect(await context.worker.step()).toMatchObject({ state: 'paused', signals: 0, fills: 0 });
    expect(await database.paper.readOpenIntents(context.id)).toHaveLength(0);
    await context.worker.close();
  });
  it('전략 → 의도 → 예약 → 다음 관측의 부분 체결 → 매도까지 연결한다', async () => {
    const context = await fixture();
    await context.worker.start();
    expect(await context.worker.step()).toMatchObject({ signals: 1, fills: 0 });
    expect(await context.worker.step()).toMatchObject({ signals: 0, fills: 1 });
    expect(await context.worker.step()).toMatchObject({ signals: 0, fills: 1 });
    expect((await database.paper.readAccount(context.id)).snapshot).toMatchObject({
      cash: { KRW: '12797' },
      positions: [{ quantity: '2' }],
    });
    context.bearish();
    expect(await context.worker.step()).toMatchObject({ signals: 1, fills: 0 });
    await context.worker.step();
    await context.worker.step();
    expect((await database.paper.readAccount(context.id)).snapshot).toMatchObject({
      cash: { KRW: '14591' },
      positions: [],
      dailyPnl: { KRW: { netPnl: '-409' } },
    });
    await context.worker.close();
    expect((await database.paper.readAccount(context.id)).leaseUntil).toBeNull();
  }, 15_000);
  it('부분 체결 뒤 종료·재시작은 보유분과 손실을 보존하고 자동 재개하지 않는다', async () => {
    const context = await fixture();
    await context.worker.start();
    await context.worker.step();
    await context.worker.step();
    const [intent] = await database.paper.readOpenIntents(context.id);
    await context.worker.close();
    expect(await database.paper.readIntent(context.id, intent!.intentId)).toMatchObject({
      state: 'ABORTED',
      filledQuantity: '1',
    });
    const replacement = context.create({ ...context.config, resume: false });
    await replacement.start();
    expect(await replacement.step()).toMatchObject({ state: 'paused', signals: 0, fills: 0 });
    expect((await database.paper.readAccount(context.id)).snapshot).toMatchObject({
      cash: { KRW: '13898' },
      positions: [{ quantity: '1' }],
      dailyPnl: { KRW: { netPnl: '-2' } },
    });
    await replacement.close();
  });
  it('경합 worker는 현재 소유자를 정지시키거나 lease를 빼앗지 않는다', async () => {
    const context = await fixture();
    await context.worker.start();
    await expect(context.create().start()).rejects.toThrow('PAPER_LEASE_BUSY');
    expect(await context.worker.step()).toMatchObject({ state: 'running' });
    await context.worker.close();
  });
  it('긴급 정지 후에는 체결을 추가하지 않고 잔량만 중단한다', async () => {
    const context = await fixture();
    await context.worker.start();
    await context.worker.step();
    await context.worker.step();
    await database.paper.stop(context.id, 'EMERGENCY_TEST');
    await expect(context.worker.step()).rejects.toThrow('PAPER_CONTROL_CHANGED');
    expect(await database.paper.readAccount(context.id)).toMatchObject({
      control: { stopped: true, reason: 'EMERGENCY_TEST' },
      snapshot: { positions: [{ quantity: '1' }], reservations: [] },
    });
  });
  it('수집 오류는 정지·lease 해제·미체결 중단으로 이어진다', async () => {
    const context = await fixture();
    await context.worker.start();
    await context.worker.step();
    context.fail();
    await expect(context.worker.step()).rejects.toThrow('RAW_SOURCE_ERROR_DO_NOT_LOG');
    expect(await database.paper.readAccount(context.id)).toMatchObject({
      control: { stopped: true },
      leaseUntil: null,
      snapshot: { positions: [], reservations: [] },
    });
  });
  it('동시에 tick을 실행하지 않으며 응답 없는 수집도 종료 시 취소한다', async () => {
    const context = await fixture();
    await context.worker.start();
    context.stall();
    const pending = context.worker.step();
    const failure = expect(pending).rejects.toThrow();
    await expect(context.worker.step()).rejects.toThrow('PAPER_WORKER_NOT_READY');
    await context.worker.close();
    await failure;
    expect((await database.paper.readAccount(context.id)).leaseUntil).toBeNull();
  });
  it('DB 저장 조건을 실행하고 변경 시 이전 worker가 멈춘다', async () => {
    const context = await fixture();
    const definition = {
      kind: 'moving-average-cross',
      instrument: { market: 'KR', symbol: '005930' },
      parameters: { fastPeriod: 1, slowPeriod: 2 },
      quantity: '3',
      maxFillQuantity: '1',
    };
    await database.paper.updateStrategy(context.id, 'test-ma', { expectedRevision: 1, enabled: true, definition });
    await context.worker.start();
    await context.worker.step();
    const [intent] = await database.paper.readOpenIntents(context.id);
    expect(intent).toMatchObject({ candidate: { quantity: '3' }, signal: { strategyRevision: 2 } });
    expect(intent!.signal.configHash).toMatch(/^[a-f0-9]{64}$/);
    await context.worker.step();
    await database.paper.updateStrategy(context.id, 'test-ma', { expectedRevision: 2, enabled: false, definition });
    await expect(context.worker.step()).rejects.toThrow('PAPER_CONTROL_CHANGED');
    expect((await database.paper.readAccount(context.id)).snapshot).toMatchObject({
      positions: [{ quantity: '1' }],
      reservations: [],
    });
  });
  it('비활성 전략만 남으면 명시적 재개도 새 주문을 만들지 않는다', async () => {
    const context = await fixture();
    const definition = {
      kind: 'moving-average-cross',
      instrument: { market: 'KR', symbol: '005930' },
      parameters: { fastPeriod: 1, slowPeriod: 2 },
      quantity: '3',
      maxFillQuantity: '1',
    };
    await database.paper.updateStrategy(context.id, 'test-ma', { expectedRevision: 1, enabled: false, definition });
    await expect(context.worker.start()).rejects.toThrow('PAPER_WORKER_NO_ENABLED_STRATEGIES');
    expect((await database.paper.readAccount(context.id)).control.stopped).toBe(true);
  });
  it('수집 timeout도 신규 주문을 차단하고 종료한다', async () => {
    const context = await fixture();
    const worker = context.create({ ...context.config, sourceTimeoutMs: 100 });
    await worker.start();
    context.stall();
    await expect(worker.step()).rejects.toThrow('PAPER_SOURCE_CANCELLED');
    expect((await database.paper.readAccount(context.id)).leaseUntil).toBeNull();
  });
  it('이전 worker는 소유권 인수 후 새 worker의 lease와 예약을 정리하지 못한다', async () => {
    const context = await fixture();
    await context.worker.start();
    await context.worker.step();
    await context.worker.step();
    await database.db.$client.query('UPDATE paper_accounts SET lease_until = $1 WHERE id = $2', [
      '2000-01-01T00:00:00Z',
      context.id,
    ]);
    const replacement = await database.paper.acquireLease(context.id);
    await expect(context.worker.step()).rejects.toThrow('PAPER_CONTROL_CHANGED');
    expect((await database.paper.readAccount(context.id)).snapshot.reservations).toHaveLength(1);
    await database.paper.recoverLease(context.id, replacement.token, replacement.epoch);
    expect((await database.paper.readAccount(context.id)).snapshot).toMatchObject({
      positions: [{ quantity: '1' }],
      reservations: [],
    });
    await database.paper.releaseLease(context.id, replacement.token, 'TEST_COMPLETE');
  });
  it('상시 루프는 heartbeat로 lease를 갱신한다', async () => {
    const context = await fixture();
    const renew = vi.spyOn(database.paper, 'renewLease');
    const worker = context.create({ ...context.config, intervalMs: 1000 });
    await worker.run(new AbortController().signal, () => {}, 7);
    expect(renew).toHaveBeenCalled();
    expect((await database.paper.readAccount(context.id)).leaseUntil).toBeNull();
  }, 12_000);
  it('heartbeat 실패 시 루프가 정지하고 예약을 해제한다', async () => {
    const context = await fixture();
    vi.spyOn(database.paper, 'renewLease').mockRejectedValueOnce(new Error('TEST_HEARTBEAT_FAILURE'));
    await expect(context.worker.run(new AbortController().signal)).rejects.toThrow('PAPER_WORKER_HEARTBEAT_FAILED');
    expect(await database.paper.readAccount(context.id)).toMatchObject({
      control: { stopped: true },
      leaseUntil: null,
      snapshot: { reservations: [] },
    });
  }, 12_000);
  it('유한 실행과 이미 취소된 실행은 타이머·lease를 남기지 않는다', async () => {
    const context = await fixture();
    const report = vi.fn();
    await context.worker.run(new AbortController().signal, report, 3);
    expect(report).toHaveBeenCalledTimes(3);
    expect((await database.paper.readAccount(context.id)).leaseUntil).toBeNull();
    const cancelled = context.create();
    const signal = AbortSignal.abort();
    await cancelled.run(signal);
    expect((await database.paper.readAccount(context.id)).leaseUntil).toBeNull();
  });
  it('계좌와 다른 출처의 봉은 관측·의도 기록 전에 거부하고 정지한다', async () => {
    const context = await fixture();
    const before = await database.paper.readAccount(context.id);
    const worker = context.create(context.config, async (instruments, signal) => {
      const evidence = (await context.source(instruments, signal)) as PaperEvidence[];
      evidence.forEach((entry) =>
        entry.marketData.candles.forEach((candle) => {
          candle.source = 'toss';
        }),
      );
      return evidence;
    });
    await expect(worker.start()).rejects.toThrow('PAPER_SOURCE_MISMATCH');
    const after = await database.paper.readAccount(context.id);
    expect(after.control.stopped).toBe(true);
    expect(after.leaseUntil).toBeNull();
    expect(after.snapshot.cash).toEqual(before.snapshot.cash);
    expect(after.snapshot.positions).toEqual(before.snapshot.positions);
    expect((await database.paper.readDashboard(context.id)).orders).toHaveLength(0);
  });
});
