import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, paperAccounts, paperEvents, paperIntents, paperReservations } from './index.js';
import { migrateTestDatabase, testDatabaseUrl } from '../test/setup.js';
import { accountFixture, activate, freshEvidence, order } from '../test/paper-fixtures.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('Paper DB 원장과 원자적 예약', () => {
  let database: ReturnType<typeof createDatabase>;
  let contender: ReturnType<typeof createDatabase>;
  beforeAll(async () => {
    const url = testDatabaseUrl();
    database = createDatabase(url);
    contender = createDatabase(url);
    await migrateTestDatabase(database);
  }, 30_000);
  afterAll(async () => {
    await database?.close();
    await contender?.close();
  });

  it('계좌는 정지·복구 필요로 시작하고 초기 소유분을 자동매매에 편입하지 않는다', async () => {
    const { id, ledger } = await accountFixture(database);
    expect(await database.paper.readAccount(id)).toMatchObject({
      control: { stopped: true },
      snapshot: { reconciled: false },
    });
    await database.paper.createAccount(id, { ...ledger, cash: { KRW: '999999', USD: '999999' } });
    expect((await database.paper.readAccount(id)).snapshot.cash.KRW).toBe('15000');
    await expect(
      database.paper.createAccount(`invalid-${randomUUID()}`, {
        ...ledger,
        positions: [
          {
            instrument: { market: 'KR', symbol: '005930' },
            quantity: '10',
            manualQuantity: '0',
            sellableQuantity: '10',
            ownership: [{ strategyId: 'ma-a', quantity: '10' }],
            markPrice: '1000',
            markTimestamp: ledger.observedAt,
            markObservedAt: ledger.observedAt,
          },
        ],
      }),
    ).rejects.toThrow('PAPER_INITIAL_OWNERSHIP_MUST_BE_MANUAL');
    const lease = await database.paper.acquireLease(id);
    await expect(contender.paper.acquireLease(id)).rejects.toThrow('PAPER_LEASE_BUSY');
    const view = await database.paper.readAccount(id);
    await expect(database.paper.resume(id, lease.token, view.snapshot.version)).rejects.toThrow(
      'PAPER_RECOVERY_REQUIRED',
    );
  });
  it('두 전략의 동시 매수는 최신 예약을 합산해 한 건만 현금을 확보한다', async () => {
    const { id } = await accountFixture(database);
    const lease = await activate(database, id);
    const first = await freshEvidence(database);
    const second = await freshEvidence(database, '005380');
    first.quote.price = '1100';
    const requests = [order(id, first), order(id, second, 'ma-b')];
    await Promise.all(requests.map((request) => database.paper.recordIntent(request)));
    const result = await Promise.all([
      database.paper.reserve(id, requests[0]!.candidate.intentId, lease.token, first),
      contender.paper.reserve(id, requests[1]!.candidate.intentId, lease.token, second),
    ]);
    expect(result.map((entry) => entry.intent.state).sort()).toEqual(['READY', 'RISK_REJECTED']);
    expect(result.find((entry) => entry.intent.state === 'RISK_REJECTED')!.intent.codes).toContain('INSUFFICIENT_CASH');
    const view = await database.paper.readAccount(id);
    expect(view.snapshot.reservations).toHaveLength(1);
    const winning = result.find((entry) => entry.intent.state === 'READY')!.intent;
    const [resource] = await database.db
      .select()
      .from(paperReservations)
      .where(and(eq(paperReservations.accountId, id), eq(paperReservations.active, true)));
    expect(resource!.cashAmount).toBe(winning.decision!.reservation!.cashAmount);
    expect(view.snapshot.reservations[0]!.limitPrice).toBe(winning.decision!.reservation!.valuationPrice);
  });
  it('영구 신호 키·요청 내용으로 중복을 제거하고 원본 변경을 거부한다', async () => {
    const { id } = await accountFixture(database);
    const lease = await activate(database, id);
    const evidence = await freshEvidence(database);
    const request = order(id, evidence);
    await database.paper.recordIntent(request);
    const replay = await contender.paper.recordIntent({
      ...request,
      candidate: { ...request.candidate, intentId: randomUUID(), limitPrice: '1000.00' },
    });
    expect(replay.intent.intentId).toBe(request.candidate.intentId);
    expect(replay.replayed).toBe(true);
    await expect(
      database.paper.recordIntent({ ...request, candidate: { ...request.candidate, quantity: '11' } }),
    ).rejects.toThrow('PAPER_INTENT_CONFLICT');
    const first = await database.paper.reserve(id, request.candidate.intentId, lease.token, evidence);
    expect(first.intent.state).toBe('READY');
    expect((await contender.paper.reserve(id, request.candidate.intentId, lease.token, evidence)).replayed).toBe(true);
    expect((await database.paper.readAccount(id)).snapshot.reservations).toHaveLength(1);
    await expect(
      database.db
        .update(paperReservations)
        .set({ active: false })
        .where(and(eq(paperReservations.accountId, id), eq(paperReservations.intentId, request.candidate.intentId))),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
    await database.paper.abort(id, request.candidate.intentId, 'OPERATOR_ABORT');
    expect((await database.paper.reserve(id, request.candidate.intentId, lease.token, evidence)).intent.state).toBe(
      'ABORTED',
    );
    expect((await database.paper.recordIntent(request)).intent.state).toBe('ABORTED');
    await expect(
      database.db
        .update(paperIntents)
        .set({ state: 'READY', version: 3 })
        .where(and(eq(paperIntents.accountId, id), eq(paperIntents.intentId, request.candidate.intentId))),
    ).rejects.toMatchObject({ cause: { code: '55000' } });
    await expect(database.db.delete(paperEvents).where(eq(paperEvents.accountId, id))).rejects.toMatchObject({
      cause: { code: '55000' },
    });
  });
  it('타 전략 매도와 경합해도 전체 매도 가능량과 수동 보유분을 보호한다', async () => {
    const { id } = await accountFixture(database, '15000');
    const [row] = await database.db.select().from(paperAccounts).where(eq(paperAccounts.id, id));
    const evidence = await freshEvidence(database);
    await database.db
      .update(paperAccounts)
      .set({
        ledger: {
          ...row!.ledger,
          positions: [
            {
              instrument: evidence.quote.instrument,
              quantity: '100',
              manualQuantity: '90',
              sellableQuantity: '7',
              ownership: [
                { strategyId: 'ma-a', quantity: '5' },
                { strategyId: 'ma-b', quantity: '5' },
              ],
              markPrice: '1000',
              markTimestamp: evidence.quote.timestamp,
              markObservedAt: evidence.quote.observedAt,
            },
          ],
        },
      })
      .where(eq(paperAccounts.id, id));
    const lease = await activate(database, id);
    const requests = [order(id, evidence, 'ma-a', '5', 'SELL'), order(id, evidence, 'ma-b', '5', 'SELL')];
    await Promise.all(requests.map((request) => database.paper.recordIntent(request)));
    const result = await Promise.all([
      database.paper.reserve(id, requests[0]!.candidate.intentId, lease.token, evidence),
      contender.paper.reserve(id, requests[1]!.candidate.intentId, lease.token, evidence),
    ]);
    expect(result.map((entry) => entry.intent.state).sort()).toEqual(['READY', 'RISK_REJECTED']);
    expect(result.find((entry) => entry.intent.state === 'RISK_REJECTED')!.intent.codes).toContain(
      'INSUFFICIENT_OWNED_QUANTITY',
    );
    const view = await database.paper.readAccount(id);
    expect(view.snapshot.positions[0]!.manualQuantity).toBe('90');
    expect(view.snapshot.reservations).toHaveLength(1);
  });
  it('정지 경합과 소유권 인수는 기존 검사를 무효화하고 복구 전 재개를 막는다', async () => {
    const { id } = await accountFixture(database);
    const lease = await activate(database, id);
    const evidence = await freshEvidence(database);
    const request = order(id, evidence);
    await database.paper.recordIntent(request);
    await Promise.all([
      database.paper.reserve(id, request.candidate.intentId, lease.token, evidence),
      contender.paper.stop(id, 'EMERGENCY'),
    ]);
    expect((await database.paper.readAccount(id)).control.stopped).toBe(true);
    const stored = await database.paper.readIntent(id, request.candidate.intentId);
    if (stored.state === 'READY')
      expect((await database.paper.reserve(id, stored.intentId, lease.token, evidence)).intent.state).toBe('ABORTED');
    await database.db.update(paperAccounts).set({ leaseUntil: '2000-01-01T00:00:00Z' }).where(eq(paperAccounts.id, id));
    const replacement = await contender.paper.acquireLease(id);
    const view = await contender.paper.readAccount(id);
    expect(view).toMatchObject({ control: { stopped: true }, snapshot: { reconciled: false } });
    const another = order(id, evidence, 'ma-b');
    await database.paper.recordIntent(another);
    await expect(database.paper.reserve(id, another.candidate.intentId, lease.token, evidence)).rejects.toThrow(
      'PAPER_LEASE_NOT_OWNED',
    );
    expect((await database.paper.readIntent(id, another.candidate.intentId)).state).toBe('INTENT_RECORDED');
    await expect(
      contender.paper.resume(id, replacement.token, (await contender.paper.readAccount(id)).snapshot.version),
    ).rejects.toThrow('PAPER_RECOVERY_REQUIRED');
  });
  it('실패한 예약 트랜잭션은 자원을 남기지 않고 먼저 기록한 의도는 보존한다', async () => {
    const { id } = await accountFixture(database);
    const lease = await activate(database, id);
    const evidence = await freshEvidence(database);
    const request = order(id, evidence);
    await database.paper.recordIntent(request);
    await database.db.execute(
      sql`CREATE FUNCTION fail_paper_test_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind = 'RESERVATION_CREATED' THEN RAISE EXCEPTION 'TEST_FAULT'; END IF; RETURN NEW; END; $$`,
    );
    await database.db.execute(
      sql`CREATE TRIGGER fail_paper_test_event BEFORE INSERT ON paper_events FOR EACH ROW EXECUTE FUNCTION fail_paper_test_event()`,
    );
    try {
      await expect(database.paper.reserve(id, request.candidate.intentId, lease.token, evidence)).rejects.toThrow(
        'PAPER_STORAGE_FAILED',
      );
    } finally {
      await database.db.execute(sql`DROP TRIGGER fail_paper_test_event ON paper_events`);
      await database.db.execute(sql`DROP FUNCTION fail_paper_test_event()`);
    }
    expect((await contender.paper.readIntent(id, request.candidate.intentId)).state).toBe('INTENT_RECORDED');
    expect((await contender.paper.readAccount(id)).snapshot.reservations).toHaveLength(0);
    expect((await contender.paper.reserve(id, request.candidate.intentId, lease.token, evidence)).intent.state).toBe(
      'READY',
    );
  });
  it('시장 증거가 오래됐거나 신호 봉이 현재 종료 봉과 다르면 거부 이력을 남긴다', async () => {
    const { id } = await accountFixture(database);
    const lease = await activate(database, id);
    const evidence = await freshEvidence(database);
    const request = order(id, evidence);
    request.signal.barTimestamp = new Date(Date.parse(request.signal.barTimestamp) + 60_000).toISOString();
    await database.paper.recordIntent(request);
    const mismatch = await database.paper.reserve(id, request.candidate.intentId, lease.token, evidence);
    expect(mismatch.intent.state).toBe('RISK_REJECTED');
    expect(mismatch.intent.codes).toContain('SIGNAL_NOT_CURRENT');
    expect(mismatch.intent.decision!.canReserve).toBe(false);
    const stale = order(id, evidence, 'ma-b');
    await database.paper.recordIntent(stale);
    evidence.quote.timestamp = '2000-01-01T00:00:00Z';
    expect((await database.paper.reserve(id, stale.candidate.intentId, lease.token, evidence)).intent.codes).toContain(
      'DATA_NOT_READY',
    );
    expect((await database.paper.readAccount(id)).snapshot.reservations).toHaveLength(0);
  });
  it('예약 처리 도중 lease가 만료되면 READY로 확정하지 않고 자원을 해제한다', async () => {
    const { id } = await accountFixture(database);
    const lease = await activate(database, id);
    const evidence = await freshEvidence(database);
    const request = order(id, evidence);
    await database.paper.recordIntent(request);
    await database.db.execute(
      sql`CREATE FUNCTION wait_paper_test_lease() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE expiry timestamptz; BEGIN SELECT lease_until INTO expiry FROM paper_accounts WHERE id = NEW.account_id; PERFORM pg_sleep(greatest(0, extract(epoch FROM expiry - clock_timestamp())) + 0.05); RETURN NEW; END; $$`,
    );
    await database.db.execute(
      sql`CREATE TRIGGER test_wait_paper_lease BEFORE INSERT ON paper_reservations FOR EACH ROW EXECUTE FUNCTION wait_paper_test_lease()`,
    );
    try {
      await database.paper.renewLease(id, lease.token, 2000);
      const result = await database.paper.reserve(id, request.candidate.intentId, lease.token, evidence);
      expect(result.intent).toMatchObject({ state: 'ABORTED', codes: ['EXPIRED_BEFORE_READY'] });
    } finally {
      await database.db.execute(sql`DROP TRIGGER test_wait_paper_lease ON paper_reservations`);
      await database.db.execute(sql`DROP FUNCTION wait_paper_test_lease()`);
    }
    expect((await contender.paper.readAccount(id)).snapshot.reservations).toHaveLength(0);
    expect((await contender.paper.readAccount(id)).snapshot.cash.KRW).toBe('15000');
  }, 20_000);
  it('호출자가 한도·snapshot을 끼워 넣을 수 없고 DB 전략 상태로 검증한다', async () => {
    const { id } = await accountFixture(database);
    const lease = await activate(database, id);
    const evidence = await freshEvidence(database);
    const request = order(id, evidence);
    await database.paper.recordIntent(request);
    await expect(
      database.paper.reserve(id, request.candidate.intentId, lease.token, {
        ...evidence,
        snapshot: { cash: '999999' },
      }),
    ).rejects.toThrow('PAPER_INPUT_INVALID');
    const unknown = order(id, evidence, 'unregistered');
    await database.paper.recordIntent(unknown);
    expect(
      (await database.paper.reserve(id, unknown.candidate.intentId, lease.token, evidence)).intent.codes,
    ).toContain('STRATEGY_DISABLED');
    expect((await database.paper.readAccount(id)).snapshot.reservations).toHaveLength(0);
  });
  it('DB 자원 검사도 USD 센트와 극소 비용을 정확히 올림한다', async () => {
    const { id } = await accountFixture(database);
    const evidence = await freshEvidence(database);
    const request = order(id, evidence);
    request.candidate.instrument = { market: 'US', symbol: 'AAPL' };
    request.candidate.quantity = '1';
    request.candidate.limitPrice = '10';
    await database.paper.recordIntent(request);
    const resource = {
      accountId: id,
      intentId: request.candidate.intentId,
      quantity: '1',
      valuationPrice: '10.01',
      cashAmount: '10.02',
      sellQuantity: '0',
      costBps: '10',
      validUntil: new Date(Date.now() + 60_000).toISOString(),
    };
    await expect(database.db.insert(paperReservations).values(resource)).rejects.toMatchObject({
      cause: { code: '55000' },
    });
    const insertReady = (value: typeof resource) =>
      database.db.transaction(async (transaction) => {
        await transaction.insert(paperReservations).values(value);
        await transaction
          .update(paperIntents)
          .set({ state: 'READY', version: 1 })
          .where(and(eq(paperIntents.accountId, value.accountId), eq(paperIntents.intentId, value.intentId)));
      });
    await expect(
      database.db.insert(paperReservations).values({ ...resource, cashAmount: '10.03' }),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
    await insertReady({ ...resource, cashAmount: '10.03' });
    const tiny = order(id, evidence);
    tiny.candidate.quantity = '1';
    await database.paper.recordIntent(tiny);
    const minimal = {
      ...resource,
      intentId: tiny.candidate.intentId,
      valuationPrice: '1000',
      cashAmount: '1000',
      costBps: '0.0000000000000000000000001',
    };
    await expect(database.db.insert(paperReservations).values(minimal)).rejects.toMatchObject({
      cause: { code: '55000' },
    });
    await insertReady({ ...minimal, cashAmount: '1001' });
  });
});
