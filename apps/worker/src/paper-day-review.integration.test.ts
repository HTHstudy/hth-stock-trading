import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDatabase } from '@hth/database';
import { migrateTestDatabase, testDatabaseUrl } from '@hth/database/testing';
import { marketTradingDate } from '@hth/trading';
import type { Quote } from '@hth/broker';
import { applyPaperDayReview, planPaperDayReview } from './paper-day-review.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('거래일 검토 계획과 승인 (fixture quotes)', () => {
  let database: ReturnType<typeof createDatabase>;
  beforeAll(async () => {
    database = createDatabase(testDatabaseUrl());
    await migrateTestDatabase(database);
  }, 30000);
  afterAll(async () => {
    await database?.close();
  });
  async function fixture() {
    const id = `paper-market-${randomUUID()}`;
    const old = Date.now() - 5 * 86400000;
    await database.paper.createAccount(
      id,
      {
        cash: { KRW: '15000', USD: '1000' },
        observedAt: new Date(old).toISOString(),
        reconciled: false,
        positions: [
          {
            instrument: { market: 'KR', symbol: '005930' },
            quantity: '1',
            manualQuantity: '1',
            sellableQuantity: '1',
            ownership: [],
            markPrice: '1000',
            markTimestamp: new Date(old).toISOString(),
            markObservedAt: new Date(old).toISOString(),
          },
        ],
        dailyPnl: {
          KRW: { tradingDate: marketTradingDate(old, 'KR'), netPnl: '-500' },
          USD: { tradingDate: marketTradingDate(old, 'US'), netPnl: '100' },
        },
      },
      'toss-readonly',
    );
    const broker = {
      getQuotes: vi.fn(async (): Promise<readonly Quote[]> => [
        {
          instrument: { market: 'KR', symbol: '005930' },
          price: '900',
          currency: 'KRW',
          timestamp: new Date().toISOString(),
        },
      ]),
    };
    const dependencies = {
      paper: database.paper,
      clientId: `fixture-${id}`,
      withBrokerLease: database.withBrokerLease,
      createBroker: vi.fn(() => broker),
    };
    const apply = (plan: unknown, acknowledgement = 'CARRY_FORWARD_PAPER_LOSSES') =>
      applyPaperDayReview(dependencies, plan, acknowledgement, new AbortController().signal);
    return { id, broker, dependencies, apply };
  }
  it('계획 생성은 무변경이며 승인은 손실+평가 차이를 이월하고 자산 소유권/정지를 유지한다', async () => {
    const context = await fixture();
    const before = await database.paper.readAccount(context.id);
    const plan = await planPaperDayReview(database.paper, context.id);
    expect((await database.paper.readAccount(context.id)).snapshot).toEqual(before.snapshot);
    await context.apply(plan);
    const after = await database.paper.readAccount(context.id);
    expect(after.control).toMatchObject({ stopped: true, reason: 'DAILY_REVIEW_COMPLETED' });
    expect(after.leaseUntil).toBeNull();
    expect(after.snapshot.cash).toEqual(before.snapshot.cash);
    expect(after.snapshot.dailyPnl.KRW.netPnl).toBe('-600');
    expect(after.snapshot.dailyPnl.USD.netPnl).toBe('0');
    expect(after.snapshot.positions[0]).toMatchObject({
      quantity: '1',
      manualQuantity: '1',
      ownership: [],
      markPrice: '900',
    });
    const dashboard = await database.paper.readDashboard(context.id);
    expect(dashboard.events.some((event) => event.kind === 'DAILY_REVIEW_COMPLETED')).toBe(true);
    expect(dashboard.orders).toHaveLength(0);
    await expect(context.apply(plan)).rejects.toThrow();
  });
  it('계획 후 정지/설정 변경은 CAS 충돌로 차단하며 가격을 읽지 않는다', async () => {
    const context = await fixture();
    const plan = await planPaperDayReview(database.paper, context.id);
    await database.paper.stop(context.id, 'DASHBOARD_EMERGENCY_STOP');
    const before = await database.paper.readAccount(context.id);
    await expect(context.apply(plan)).rejects.toThrow('PAPER_VERSION_CONFLICT');
    expect(context.dependencies.createBroker).not.toHaveBeenCalled();
    expect((await database.paper.readAccount(context.id)).snapshot).toEqual(before.snapshot);
  });
  it('동의 누락·계획 만료·거래일 변경은 lease 획득 전에 차단한다', async () => {
    const context = await fixture();
    const plan = await planPaperDayReview(database.paper, context.id);
    const before = await database.paper.readAccount(context.id);
    await expect(context.apply(plan, '')).rejects.toThrow('PAPER_REVIEW_ACKNOWLEDGEMENT_REQUIRED');
    await expect(context.apply({ ...plan, expiresAt: '2000-01-01T00:00:00Z' })).rejects.toThrow('PAPER_REVIEW_EXPIRED');
    await expect(context.apply({ ...plan, targetDates: { ...plan.targetDates, KRW: '2000-01-01' } })).rejects.toThrow(
      'PAPER_REVIEW_EXPIRED',
    );
    expect((await database.paper.readAccount(context.id)).snapshot).toEqual(before.snapshot);
  });
  it('오래된 quote나 조회 실패는 손실을 변경하지 않고 정지/lease 해제를 유지한다', async () => {
    const context = await fixture();
    const before = await database.paper.readAccount(context.id);
    const plan = await planPaperDayReview(database.paper, context.id);
    context.broker.getQuotes.mockResolvedValue([
      {
        instrument: { market: 'KR', symbol: '005930' },
        price: '900',
        currency: 'KRW',
        timestamp: '2000-01-01T00:00:00Z',
      },
    ]);
    await expect(context.apply(plan)).rejects.toThrow('PAPER_OBSERVATION_STALE');
    const after = await database.paper.readAccount(context.id);
    expect(after.snapshot.dailyPnl).toEqual(before.snapshot.dailyPnl);
    expect(after.snapshot.cash).toEqual(before.snapshot.cash);
    expect(after.snapshot.positions).toEqual(before.snapshot.positions);
    expect(after.control.stopped).toBe(true);
    expect(after.leaseUntil).toBeNull();
    const next = await planPaperDayReview(database.paper, context.id);
    context.broker.getQuotes.mockRejectedValue(new Error('fixture quote failure'));
    await expect(context.apply(next)).rejects.toThrow('fixture quote failure');
    expect((await database.paper.readAccount(context.id)).snapshot.dailyPnl).toEqual(before.snapshot.dailyPnl);
  });
  it('가격 조회 중 긴급 정지가 들어오면 승인 트랜잭션을 차단한다', async () => {
    const context = await fixture();
    const before = await database.paper.readAccount(context.id);
    const plan = await planPaperDayReview(database.paper, context.id);
    context.broker.getQuotes.mockImplementation(async () => {
      await database.paper.stop(context.id, 'DASHBOARD_EMERGENCY_STOP');
      return [
        {
          instrument: { market: 'KR', symbol: '005930' },
          price: '900',
          currency: 'KRW',
          timestamp: new Date().toISOString(),
        },
      ];
    });
    await expect(context.apply(plan)).rejects.toThrow('PAPER_VERSION_CONFLICT');
    const after = await database.paper.readAccount(context.id);
    expect(after.snapshot.dailyPnl).toEqual(before.snapshot.dailyPnl);
    expect(after.control).toMatchObject({ stopped: true, reason: 'DASHBOARD_EMERGENCY_STOP' });
    expect(after.leaseUntil).toBeNull();
    expect(
      (await database.paper.readDashboard(context.id)).events.some((event) => event.kind === 'DAILY_REVIEW_COMPLETED'),
    ).toBe(false);
  });
});
