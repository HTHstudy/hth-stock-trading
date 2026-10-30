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
    let closed = false;
    let unknownCalendar = false;
    let failed = false;
    let stalled = false;
    const source: PaperSource = async (instruments, signal) => {
      if (failed) throw new Error('RAW_SOURCE_ERROR_DO_NOT_LOG');
      if (stalled) return new Promise(() => {});
      const evidence = (await paperSyntheticSource(instruments, signal)) as PaperEvidence[];
      for (const entry of evidence) {
        if (closed) entry.marketData.calendar!.today.sessions = [];
        if (unknownCalendar) entry.marketData.calendar!.today.sessionsKnown = false;
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
      closeMarket: () => {
        closed = true;
      },
      openMarket: () => {
        closed = false;
      },
      unknownCalendar: () => {
        unknownCalendar = true;
      },
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
    expect((await database.paper.readDiagnostics(context.id)).items[0]!.latest?.report).toMatchObject({
      stage: 'control',
      action: null,
      codes: ['ACCOUNT_PAUSED'],
      closedCandles: null,
    });
    expect(await database.paper.readOpenIntents(context.id)).toHaveLength(0);
    await context.worker.close();
  });
  it('같은 정지 진단을 매 tick 중복 저장하지 않는다', async () => {
    const context = await fixture(false);
    const save = vi.spyOn(database.paper, 'recordDiagnostics');
    await context.worker.start();
    await context.worker.step();
    await context.worker.step();
    expect(save).toHaveBeenCalledTimes(1);
    await context.worker.close();
  });
  it('진단 저장이 실패하면 예약을 중단하고 다음 거래로 진행하지 않는다', async () => {
    const context = await fixture();
    await context.worker.start();
    vi.spyOn(database.paper, 'recordDiagnostics').mockRejectedValueOnce(new Error('DIAGNOSTIC_STORAGE_FAILURE'));
    await expect(context.worker.step()).rejects.toThrow('DIAGNOSTIC_STORAGE_FAILURE');
    const current = await database.paper.readAccount(context.id);
    expect(current.control.stopped).toBe(true);
    expect(current.leaseUntil).toBeNull();
    expect(current.snapshot.reservations).toHaveLength(0);
    const dashboard = await database.paper.readDashboard(context.id);
    expect(dashboard.orders).toHaveLength(1);
    expect(dashboard.orders[0]!.state).toBe('ABORTED');
    expect(dashboard.fills).toHaveLength(0);
  });
  it('전략 → 의도 → 예약 → 다음 관측의 부분 체결 → 매도까지 연결한다', async () => {
    const context = await fixture();
    await context.worker.start();
    expect(await context.worker.step()).toMatchObject({ signals: 1, fills: 0 });
    expect((await database.paper.readDiagnostics(context.id)).items[0]!.latest?.report).toMatchObject({
      action: 'BUY',
      stage: 'reservation',
      codes: ['BULLISH_CROSS', 'ORDER_RESERVED'],
      orderState: 'READY',
    });
    expect(await context.worker.step()).toMatchObject({ signals: 0, fills: 1 });
    expect((await database.paper.readDiagnostics(context.id)).items[0]!.latest?.report.codes).toContain(
      'ALREADY_OWNED',
    );
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
  it('부분 체결 후 통신 장애·기본 재시작·명시적 재개에도 같은 봉 주문을 다시 만들지 않는다', async () => {
    const context = await fixture();
    const evidence = (await context.source(
      [{ market: 'KR', symbol: '005930' }],
      new AbortController().signal,
    )) as PaperEvidence[];
    let failed = false;
    const feed: PaperSource = async (instruments, signal) => {
      if (failed) throw new Error('FAULT_INJECTION');
      const fresh = (await context.source(instruments, signal)) as PaperEvidence[];
      for (let index = 0; index < fresh.length; index++)
        fresh[index]!.marketData.candles = structuredClone(evidence[index]!.marketData.candles);
      return fresh;
    };
    const worker = context.create(context.config, feed);
    await worker.start();
    await worker.step();
    await worker.step();
    const before = await database.paper.readAccount(context.id);
    failed = true;
    await expect(worker.step()).rejects.toThrow('FAULT_INJECTION');
    const stopped = await database.paper.readAccount(context.id);
    expect(stopped.control.stopped).toBe(true);
    expect(stopped.leaseUntil).toBeNull();
    expect(stopped.snapshot.reservations).toHaveLength(0);
    expect(stopped.snapshot.cash).toEqual(before.snapshot.cash);
    expect(stopped.snapshot.positions).toEqual(before.snapshot.positions);
    expect(stopped.snapshot.dailyPnl).toEqual(before.snapshot.dailyPnl);
    failed = false;
    const paused = context.create({ ...context.config, resume: false }, feed);
    await paused.start();
    expect(await paused.step()).toMatchObject({ state: 'paused', signals: 0, fills: 0 });
    await paused.close();
    const resumed = context.create(context.config, feed);
    await resumed.start();
    expect(await resumed.step()).toMatchObject({ state: 'running', signals: 0, fills: 0 });
    const dashboard = await database.paper.readDashboard(context.id);
    expect(dashboard.orders).toHaveLength(1);
    expect(dashboard.orders[0]).toMatchObject({ state: 'ABORTED', filledQuantity: '1' });
    expect(dashboard.fills).toHaveLength(1);
    await resumed.close();
  });
  it('부분 체결 후 오래된 시세가 오면 잔여 체결을 막고 이미 체결한 자산을 보존한다', async () => {
    const context = await fixture();
    let stale = false;
    const worker = context.create(context.config, async (instruments, signal) => {
      const entries = (await context.source(instruments, signal)) as PaperEvidence[];
      if (stale) for (const entry of entries) entry.quote.timestamp = new Date(Date.now() - 180000).toISOString();
      return entries;
    });
    await worker.start();
    await worker.step();
    await worker.step();
    const before = await database.paper.readAccount(context.id);
    stale = true;
    await expect(worker.step()).rejects.toThrow();
    const after = await database.paper.readAccount(context.id);
    expect(after.control.stopped).toBe(true);
    expect(after.leaseUntil).toBeNull();
    expect(after.snapshot.reservations).toHaveLength(0);
    expect(after.snapshot.cash).toEqual(before.snapshot.cash);
    expect(after.snapshot.positions).toEqual(before.snapshot.positions);
    expect(after.snapshot.dailyPnl).toEqual(before.snapshot.dailyPnl);
    const dashboard = await database.paper.readDashboard(context.id);
    expect(dashboard.orders).toHaveLength(1);
    expect(dashboard.fills).toHaveLength(1);
    expect(dashboard.orders[0]).toMatchObject({ state: 'ABORTED', filledQuantity: '1' });
  });
  it('수집 중 긴급 정지 후 늦게 도착한 정상 응답도 주문·체결을 추가하지 못한다', async () => {
    const context = await fixture();
    let delayed = false;
    let deliver!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const worker = context.create(context.config, async (instruments, signal) => {
      const entries = await context.source(instruments, signal);
      if (delayed) {
        entered();
        await new Promise<void>((resolve) => {
          deliver = resolve;
        });
      }
      return entries;
    });
    await worker.start();
    await worker.step();
    const before = await database.paper.readAccount(context.id);
    delayed = true;
    const pending = worker.step();
    const rejected = expect(pending).rejects.toThrow('PAPER_CONTROL_CHANGED');
    await waiting;
    try {
      await database.paper.stop(context.id, 'EMERGENCY_IN_FLIGHT');
    } finally {
      deliver();
    }
    await rejected;
    const after = await database.paper.readAccount(context.id);
    expect(after.control).toMatchObject({ stopped: true, reason: 'EMERGENCY_IN_FLIGHT' });
    expect(after.leaseUntil).toBeNull();
    expect(after.snapshot.reservations).toHaveLength(0);
    expect(after.snapshot.cash).toEqual(before.snapshot.cash);
    expect(after.snapshot.positions).toEqual(before.snapshot.positions);
    const dashboard = await database.paper.readDashboard(context.id);
    expect(dashboard.orders).toHaveLength(1);
    expect(dashboard.fills).toHaveLength(0);
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
    const diagnostic = await database.paper.readDiagnostics(context.id);
    expect(diagnostic.items[0]!.latest?.report).toMatchObject({
      stage: 'source',
      action: null,
      codes: ['SOURCE_UNAVAILABLE'],
    });
    expect(JSON.stringify(diagnostic)).not.toContain('RAW_SOURCE_ERROR_DO_NOT_LOG');
    expect(await database.paper.readAccount(context.id)).toMatchObject({
      control: { stopped: true },
      leaseUntil: null,
      snapshot: { positions: [], reservations: [] },
    });
  });
  it('필요한 봉 수가 부족하면 HOLD/WARMUP을 기록하며 주문하지 않는다', async () => {
    const context = await fixture();
    const worker = context.create({
      ...context.config,
      strategies: context.config.strategies.map((s) => ({ ...s, parameters: { fastPeriod: 1, slowPeriod: 3 } })),
    });
    await worker.start();
    expect(await worker.step()).toMatchObject({ signals: 0, fills: 0 });
    expect((await database.paper.readDiagnostics(context.id)).items[0]!.latest?.report).toMatchObject({
      action: 'HOLD',
      codes: ['WARMUP'],
      closedCandles: 3,
    });
    expect((await database.paper.readDashboard(context.id)).orders).toHaveLength(0);
    await worker.close();
  });
  it('신선도가 만료된 입력의 구체적 차단 사유를 기록하고 중단한다', async () => {
    const context = await fixture();
    let stale = false;
    const worker = context.create(context.config, async (instruments, signal) => {
      const evidence = (await context.source(instruments, signal)) as PaperEvidence[];
      if (stale)
        evidence.forEach((entry) => {
          entry.quote.timestamp = new Date(Date.now() - 180000).toISOString();
        });
      return evidence;
    });
    await worker.start();
    stale = true;
    await expect(worker.step()).rejects.toThrow('PAPER_WORKER_DATA_NOT_READY');
    expect((await database.paper.readDiagnostics(context.id)).items[0]!.latest?.report).toMatchObject({
      action: null,
      stage: 'data',
      codes: expect.arrayContaining(['QUOTE_STALE']),
    });
    expect((await database.paper.readAccount(context.id)).control.stopped).toBe(true);
  });
  it('실제 리스크 거부 결과와 같은 봉의 중복 신호 차단을 각각 기록한다', async () => {
    const rejected = await fixture();
    const tooLarge = rejected.create({
      ...rejected.config,
      strategies: rejected.config.strategies.map((s) => ({ ...s, quantity: '999' })),
    });
    await tooLarge.start();
    await tooLarge.step();
    expect((await database.paper.readDiagnostics(rejected.id)).items[0]!.latest?.report).toMatchObject({
      action: 'BUY',
      stage: 'reservation',
      orderState: 'RISK_REJECTED',
      codes: expect.arrayContaining(['ORDER_AMOUNT_LIMIT']),
    });
    await tooLarge.close();
    const context = await fixture();
    let move = false;
    const worker = context.create(context.config, async (instruments, signal) => {
      const entries = (await context.source(instruments, signal)) as PaperEvidence[];
      if (move)
        entries.forEach((entry) => {
          entry.quote.price = '1101';
        });
      return entries;
    });
    await worker.start();
    await worker.step();
    move = true;
    await worker.step();
    expect((await database.paper.readDiagnostics(context.id)).items[0]!.latest?.report).toMatchObject({
      codes: expect.arrayContaining(['DUPLICATE_SIGNAL']),
      orderState: 'READY',
    });
    expect((await database.paper.readDashboard(context.id)).orders).toHaveLength(1);
    await worker.close();
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
  it('휴장 시 예약을 정리하고 손실/자산을 보존하며 개장해도 자동 재개하지 않는다', async () => {
    const context = await fixture();
    await context.worker.start();
    await context.worker.step();
    expect((await database.paper.readAccount(context.id)).snapshot.reservations).toHaveLength(1);
    const before = await database.paper.readAccount(context.id);
    context.closeMarket();
    expect(await context.worker.step()).toMatchObject({ state: 'waiting', signals: 0, fills: 0 });
    const parked = await database.paper.readAccount(context.id);
    expect(parked.control).toMatchObject({ stopped: true, reason: 'MARKET_CLOSED' });
    expect(parked.snapshot.reservations).toHaveLength(0);
    expect(parked.snapshot.cash).toEqual(before.snapshot.cash);
    expect(parked.snapshot.dailyPnl).toEqual(before.snapshot.dailyPnl);
    expect(parked.snapshot.observedAt).toEqual(before.snapshot.observedAt);
    expect(await context.worker.step()).toMatchObject({ state: 'waiting' });
    expect((await database.paper.readAccount(context.id)).control.epoch).toBe(parked.control.epoch);
    context.openMarket();
    expect(await context.worker.step()).toMatchObject({ state: 'paused', signals: 0, fills: 0 });
    expect((await database.paper.readAccount(context.id)).control.stopped).toBe(true);
  });
  it('휴장 중 resume 요청을 보류하며 미확인 캘린더는 대기로 위장하지 않는다', async () => {
    const context = await fixture();
    context.closeMarket();
    await context.worker.start();
    expect((await database.paper.readAccount(context.id)).control.stopped).toBe(true);
    context.unknownCalendar();
    await expect(context.worker.step()).rejects.toThrow('PAPER_SESSION_UNVERIFIED');
    expect((await database.paper.readAccount(context.id)).leaseUntil).toBeNull();
  });
});
