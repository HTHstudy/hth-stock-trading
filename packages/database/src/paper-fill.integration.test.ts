import { randomUUID } from 'node:crypto';
import { paperLedgerStateSchema } from '@hth/contracts';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, paperAccounts, paperCostBasis, paperFills, paperReservations, paperIntents } from './index.js';
import { migrateTestDatabase, testDatabaseUrl } from '../test/setup.js';
import { accountFixture, activate, freshEvidence, order } from '../test/paper-fixtures.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('Paper 합성 체결 원장', () => {
  let database: ReturnType<typeof createDatabase>;
  let contender: ReturnType<typeof createDatabase>;
  beforeAll(async () => {
    database = createDatabase(testDatabaseUrl());
    contender = createDatabase(testDatabaseUrl());
    await migrateTestDatabase(database);
  }, 30_000);
  afterAll(async () => {
    await database?.close();
    await contender?.close();
  });
  async function ready(quantity = '10', limitPrice = '1000') {
    const { id } = await accountFixture(database);
    const lease = await activate(database, id);
    const evidence = await freshEvidence(database);
    const request = order(id, evidence, 'ma-a', quantity);
    request.candidate.limitPrice = limitPrice;
    await database.paper.recordIntent(request);
    expect((await database.paper.reserve(id, request.candidate.intentId, lease.token, evidence)).intent.state).toBe(
      'READY',
    );
    return { id, token: lease.token, intentId: request.candidate.intentId };
  }
  async function fill(
    context: Awaited<ReturnType<typeof ready>>,
    quantity: string,
    fillId = randomUUID(),
    price = '1000',
  ) {
    const evidence = await freshEvidence(database);
    evidence.quote.price = price;
    return database.paper.fill(context.id, context.intentId, context.token, { fillId, quantity }, evidence);
  }
  it('부분·전체 매수와 매도는 현금·예약·전략 소유권·원가를 함께 반영한다', async () => {
    const context = await ready();
    await fill(context, '4');
    expect((await database.paper.readAccount(context.id)).snapshot).toMatchObject({
      cash: { KRW: '10996' },
      reservations: [{ remainingQuantity: '6', filledNotional: '4000', paidCosts: '4' }],
    });
    expect((await database.paper.readIntent(context.id, context.intentId)).state).toBe('PARTIALLY_FILLED');
    await fill(context, '6');
    const bought = (await database.paper.readAccount(context.id)).snapshot;
    expect(bought).toMatchObject({
      cash: { KRW: '4990' },
      reservations: [],
      positions: [{ quantity: '10', manualQuantity: '0' }],
    });
    const evidence = await freshEvidence(database);
    const sell = order(context.id, evidence, 'ma-a', '10', 'SELL');
    await database.paper.recordIntent(sell);
    expect(
      (await database.paper.reserve(context.id, sell.candidate.intentId, context.token, evidence)).intent.state,
    ).toBe('READY');
    const sellContext = { ...context, intentId: sell.candidate.intentId };
    await fill(sellContext, '5', randomUUID(), '1100');
    const result = await fill(sellContext, '5', randomUUID(), '1100');
    expect(result.fill).toMatchObject({ costs: '16', realizedPnl: '479' });
    const final = (await database.paper.readAccount(context.id)).snapshot;
    expect(final).toMatchObject({
      cash: { KRW: '15957' },
      positions: [],
      reservations: [],
      dailyPnl: { KRW: { netPnl: '957' } },
    });
    const [basis] = await database.db.select().from(paperCostBasis).where(eq(paperCostBasis.accountId, context.id));
    expect(basis).toMatchObject({ quantity: '0', amount: '0' });
  });
  it('동시 재요청과 정지 후 재조회도 같은 체결 키를 한 번만 반영한다', async () => {
    const context = await ready();
    const fillId = randomUUID();
    const evidence = await freshEvidence(database);
    const [a, b] = await Promise.all([
      database.paper.fill(context.id, context.intentId, context.token, { fillId, quantity: '4' }, evidence),
      contender.paper.fill(context.id, context.intentId, context.token, { fillId, quantity: '4' }, evidence),
    ]);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    await database.paper.stop(context.id, 'TEST_STOP');
    expect((await fill(context, '4', fillId, '999')).replayed).toBe(true);
    await expect(fill(context, '5', fillId)).rejects.toThrow('PAPER_FILL_CONFLICT');
    expect(await database.paper.readFills(context.id, context.intentId)).toHaveLength(1);
    expect((await database.paper.readAccount(context.id)).snapshot.cash.KRW).toBe('10996');
  });
  it('동시 부분 체결이 잔량을 넘지 않고 중단은 미체결분만 해제한다', async () => {
    const context = await ready();
    const evidence = await freshEvidence(database);
    const results = await Promise.allSettled([
      database.paper.fill(
        context.id,
        context.intentId,
        context.token,
        { fillId: randomUUID(), quantity: '6' },
        evidence,
      ),
      contender.paper.fill(
        context.id,
        context.intentId,
        context.token,
        { fillId: randomUUID(), quantity: '6' },
        evidence,
      ),
    ]);
    expect(results.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
    await database.paper.abort(context.id, context.intentId, 'STOP_REMAINDER');
    expect((await database.paper.readAccount(context.id)).snapshot).toMatchObject({
      cash: { KRW: '8994' },
      reservations: [],
      positions: [{ quantity: '6' }],
    });
    expect(await database.paper.readIntent(context.id, context.intentId)).toMatchObject({
      state: 'ABORTED',
      filledQuantity: '6',
    });
    expect(await database.paper.readFills(context.id, context.intentId)).toHaveLength(1);
  });
  it('지정가 미도달·오래된 시세·정지는 새 체결과 자금 변경을 만들지 않는다', async () => {
    const context = await ready('10', '999');
    expect((await fill(context, '4')).fill).toBeNull();
    const evidence = await freshEvidence(database);
    evidence.quote.timestamp = '2000-01-01T00:00:00Z';
    await expect(
      database.paper.fill(
        context.id,
        context.intentId,
        context.token,
        { fillId: randomUUID(), quantity: '4' },
        evidence,
      ),
    ).rejects.toThrow('PAPER_FILL_DATA_NOT_READY');
    await database.paper.stop(context.id, 'TEST_STOP');
    await expect(fill(context, '4', randomUUID(), '999')).rejects.toThrow('PAPER_RESERVATION_STALE');
    expect((await database.paper.readAccount(context.id)).snapshot).toMatchObject({
      cash: { KRW: '15000' },
      positions: [],
      reservations: [],
    });
  });
  it('체결 이력과 누적 합계는 변경·삭제·단독 조작할 수 없다', async () => {
    const context = await ready();
    await fill(context, '4');
    await expect(database.db.delete(paperFills).where(eq(paperFills.accountId, context.id))).rejects.toMatchObject({
      cause: { code: '55000' },
    });
    await expect(
      database.db.update(paperFills).set({ costs: '0' }).where(eq(paperFills.accountId, context.id)),
    ).rejects.toMatchObject({ cause: { code: '55000' } });
    const intent = await database.paper.readIntent(context.id, context.intentId);
    await expect(
      database.db
        .update(paperIntents)
        .set({
          state: 'FILLED',
          filledQuantity: '10',
          filledNotional: '10000',
          paidCosts: '10',
          version: intent.version + 1,
        })
        .where(and(eq(paperIntents.accountId, context.id), eq(paperIntents.intentId, context.intentId))),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });
  it('체결 저장 후 장애가 발생하면 잔고·원가·상태·예약까지 모두 롤백한다', async () => {
    const context = await ready();
    await database.db.execute(
      sql`CREATE FUNCTION fail_paper_fill_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind = 'PAPER_FILL_RECORDED' AND NEW.account_id = TG_ARGV[0] THEN RAISE EXCEPTION 'TEST_FAULT'; END IF; RETURN NEW; END; $$`,
    );
    await database.db.execute(
      sql`CREATE TRIGGER fail_paper_fill_test BEFORE INSERT ON paper_events FOR EACH ROW EXECUTE FUNCTION fail_paper_fill_test(${sql.raw(`'${context.id}'`)})`,
    );
    const fillId = randomUUID();
    try {
      await expect(fill(context, '4', fillId)).rejects.toThrow('PAPER_STORAGE_FAILED');
    } finally {
      await database.db.execute(sql`DROP TRIGGER fail_paper_fill_test ON paper_events`);
      await database.db.execute(sql`DROP FUNCTION fail_paper_fill_test()`);
    }
    expect((await database.paper.readAccount(context.id)).snapshot).toMatchObject({
      cash: { KRW: '15000' },
      positions: [],
      reservations: [{ remainingQuantity: '10' }],
    });
    expect(
      await database.db.select().from(paperCostBasis).where(eq(paperCostBasis.accountId, context.id)),
    ).toHaveLength(0);
    expect(await database.paper.readFills(context.id, context.intentId)).toHaveLength(0);
    expect((await fill(context, '4', fillId)).replayed).toBe(false);
  });
  it('부분 체결 후 만료와 worker 교체는 보유분을 보존하며 옛 worker의 신규 체결을 막는다', async () => {
    const context = await ready();
    await fill(context, '4');
    await database.db
      .update(paperAccounts)
      .set({ leaseUntil: '2000-01-01T00:00:00Z' })
      .where(eq(paperAccounts.id, context.id));
    await contender.paper.acquireLease(context.id);
    await expect(fill(context, '1')).rejects.toThrow('PAPER_LEASE_NOT_OWNED');
    await contender.paper.abort(context.id, context.intentId, 'RECOVERY');
    expect((await contender.paper.readAccount(context.id)).snapshot).toMatchObject({
      positions: [{ quantity: '4' }],
      reservations: [],
    });
  });
  it('달러 부분 체결은 센트 올림 수수료와 잔여 예약을 DB에서도 일치시킨다', async () => {
    const { id } = await accountFixture(database);
    const lease = await activate(database, id);
    const evidence = await freshEvidence(database, 'AAPL', 'US');
    evidence.quote.price = '0.01';
    const request = order(id, evidence, 'ma-a', '2');
    request.candidate.limitPrice = '0.01';
    await database.paper.recordIntent(request);
    expect((await database.paper.reserve(id, request.candidate.intentId, lease.token, evidence)).intent.state).toBe(
      'READY',
    );
    const run = async () => {
      const current = await freshEvidence(database, 'AAPL', 'US');
      current.quote.price = '0.01';
      return database.paper.fill(
        id,
        request.candidate.intentId,
        lease.token,
        { fillId: randomUUID(), quantity: '1' },
        current,
      );
    };
    expect((await run()).fill!.costs).toBe('0.01');
    const [remaining] = await database.db.select().from(paperReservations).where(eq(paperReservations.accountId, id));
    expect(remaining!.cashAmount).toBe('0.01');
    expect((await run()).fill!.costs).toBe('0');
    expect((await database.paper.readAccount(id)).snapshot).toMatchObject({
      cash: { KRW: '15000', USD: '999.97' },
      reservations: [],
    });
  });
  it('체결 처리 중 lease 만료는 기존 부분 체결을 보존하고 새 체결 전체를 롤백한다', async () => {
    const context = await ready();
    await fill(context, '4');
    await database.db.execute(
      sql`CREATE FUNCTION wait_paper_fill_lease_test() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE expiry timestamptz; BEGIN IF NEW.kind = 'PAPER_FILL_RECORDED' AND NEW.account_id = TG_ARGV[0] THEN SELECT lease_until INTO expiry FROM paper_accounts WHERE id = NEW.account_id; PERFORM pg_sleep(greatest(0, extract(epoch FROM expiry - clock_timestamp())) + 0.05); END IF; RETURN NEW; END; $$`,
    );
    await database.db.execute(
      sql`CREATE TRIGGER wait_paper_fill_lease_test BEFORE INSERT ON paper_events FOR EACH ROW EXECUTE FUNCTION wait_paper_fill_lease_test(${sql.raw(`'${context.id}'`)})`,
    );
    await database.paper.renewLease(context.id, context.token, 1000);
    try {
      await expect(fill(context, '6')).rejects.toThrow('PAPER_FILL_EXPIRED');
    } finally {
      await database.db.execute(sql`DROP TRIGGER wait_paper_fill_lease_test ON paper_events`);
      await database.db.execute(sql`DROP FUNCTION wait_paper_fill_lease_test()`);
    }
    expect((await database.paper.readAccount(context.id)).snapshot).toMatchObject({
      cash: { KRW: '10996' },
      positions: [{ quantity: '4' }],
      reservations: [{ remainingQuantity: '6' }],
    });
    expect(await database.paper.readFills(context.id, context.intentId)).toHaveLength(1);
    expect((await database.paper.readIntent(context.id, context.intentId)).state).toBe('PARTIALLY_FILLED');
  });
  it('수동 보유분이 섞여 있어도 매도 체결은 해당 전략 소유분만 차감한다', async () => {
    const context = await ready();
    await fill(context, '10');
    const snapshot = (await database.paper.readAccount(context.id)).snapshot;
    const ledger = paperLedgerStateSchema.strip().parse(snapshot);
    ledger.positions[0] = { ...ledger.positions[0]!, quantity: '110', manualQuantity: '100', sellableQuantity: '110' };
    await database.db.update(paperAccounts).set({ ledger }).where(eq(paperAccounts.id, context.id));
    const evidence = await freshEvidence(database);
    const sell = order(context.id, evidence, 'ma-a', '10', 'SELL');
    await database.paper.recordIntent(sell);
    expect(
      (await database.paper.reserve(context.id, sell.candidate.intentId, context.token, evidence)).intent.state,
    ).toBe('READY');
    await fill({ ...context, intentId: sell.candidate.intentId }, '10');
    expect((await database.paper.readAccount(context.id)).snapshot.positions).toMatchObject([
      { quantity: '100', manualQuantity: '100', ownership: [] },
    ]);
  });
  it('부분 체결 예약의 잔액을 DB가 검사한다', async () => {
    const context = await ready();
    await fill(context, '4');
    await expect(
      database.db
        .update(paperReservations)
        .set({ quantity: '1', cashAmount: '1' })
        .where(eq(paperReservations.accountId, context.id)),
    ).rejects.toMatchObject({ cause: { code: '55000' } });
  });
});
