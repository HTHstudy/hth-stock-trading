import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, paperAccounts, paperEvents } from './index.js';
import { migrateTestDatabase, testDatabaseUrl } from '../test/setup.js';
import { accountFixture, activate, freshEvidence, order } from '../test/paper-fixtures.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('Paper 조회 원장의 일관성과 비공개 정보 제거', () => {
  let database: ReturnType<typeof createDatabase>;
  beforeAll(async () => {
    database = createDatabase(testDatabaseUrl());
    await migrateTestDatabase(database);
  }, 30_000);
  afterAll(async () => {
    await database?.close();
  });
  it('부분 체결 후 예약·현금·평가액과 비용을 동일 원장 snapshot으로 반환한다', async () => {
    const { id } = await accountFixture(database);
    const lease = await activate(database, id);
    const input = order(id, await freshEvidence(database));
    await database.paper.recordIntent(input);
    await database.paper.reserve(id, input.candidate.intentId, lease.token, await freshEvidence(database));
    await database.paper.fill(
      id,
      input.candidate.intentId,
      lease.token,
      { fillId: randomUUID(), quantity: '4' },
      await freshEvidence(database),
    );
    const result = await database.paper.readDashboard(id);
    expect(result.portfolios[0]).toMatchObject({
      cash: '10996',
      reservedCash: '6006',
      availableCash: '4990',
      holdingsValue: '4000',
      equity: '14996',
      dailyPnl: '-4',
    });
    expect(result.orders[0]).toMatchObject({ state: 'PARTIALLY_FILLED', filledQuantity: '4', paidCosts: '4' });
    expect(result.fills[0]).toMatchObject({ quantity: '4', costs: '4' });
    expect(result.worker.state).toBe('active');
    expect(JSON.stringify(result)).not.toContain(id);
    expect(JSON.stringify(result)).not.toContain(lease.token);
    expect(JSON.stringify(result)).not.toContain('requestHash');
    expect(JSON.stringify(result)).not.toContain('decision');
  });
  it('원본 제어 사유·감사 상세·알 수 없는 코드를 브라우저에 반환하지 않는다', async () => {
    const { id } = await accountFixture(database);
    const secret = 'private-account-token';
    await database.paper.stop(id, secret);
    await database.db.insert(paperEvents).values({
      accountId: id,
      kind: secret,
      details: { token: secret, accountId: id, code: secret, codes: ['INSUFFICIENT_CASH', secret], reason: secret },
    });
    const result = await database.paper.readDashboard(id);
    expect(result.control.reason).toBe('OTHER');
    expect(result.events.some((event) => event.kind === 'OTHER' && event.codes.includes('INSUFFICIENT_CASH'))).toBe(
      true,
    );
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(id);
  });
  it('최근 50건으로 이력을 제한하고 다른 계좌 기록을 섞지 않는다', async () => {
    const { id } = await accountFixture(database);
    const other = await accountFixture(database);
    const evidence = await freshEvidence(database);
    for (let index = 0; index < 51; index++) {
      const input = order(id, evidence);
      input.signal.barTimestamp = new Date(Date.parse(input.signal.barTimestamp) - index * 60_000).toISOString();
      await database.paper.recordIntent(input);
    }
    const result = await database.paper.readDashboard(id);
    expect(result.orders).toHaveLength(50);
    expect(result.events).toHaveLength(50);
    expect(result.history).toMatchObject({ ordersLimited: true, eventsLimited: true });
    expect((await database.paper.readDashboard(other.id)).orders).toHaveLength(0);
  }, 15_000);
  it('lease 만료와 오래된 평가를 정상 실행으로 표시하지 않는다', async () => {
    const { id } = await accountFixture(database);
    await activate(database, id);
    const [row] = await database.db.select().from(paperAccounts).where(eq(paperAccounts.id, id));
    await database.db
      .update(paperAccounts)
      .set({ leaseUntil: '2000-01-01T00:00:00Z', ledger: { ...row!.ledger, observedAt: '2000-01-01T00:00:00Z' } })
      .where(eq(paperAccounts.id, id));
    expect(await database.paper.readDashboard(id)).toMatchObject({
      worker: { state: 'expired' },
      valuation: { stale: true },
    });
  });
  it('조회는 자원·제어·version을 변경하지 않는다', async () => {
    const { id } = await accountFixture(database);
    const before = await database.paper.readAccount(id);
    await database.paper.readDashboard(id);
    const after = await database.paper.readAccount(id);
    expect(after.snapshot).toEqual(before.snapshot);
    expect(after.control).toEqual(before.control);
  });
  it('계좌 행이 실행 트랜잭션에 잠겨 있어도 조회는 기다리지 않는다', async () => {
    const { id } = await accountFixture(database);
    let acquired!: () => void;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writer = database.db.transaction(async (transaction) => {
      await transaction.select().from(paperAccounts).where(eq(paperAccounts.id, id)).for('update');
      acquired();
      await gate;
    });
    await held;
    try {
      expect((await database.paper.readDashboard(id)).control.stopped).toBe(true);
    } finally {
      release();
      await writer;
    }
  }, 3000);
});
