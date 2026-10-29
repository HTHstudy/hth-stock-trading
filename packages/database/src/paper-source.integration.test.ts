import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, paperAccounts, paperIntents, contentHash } from './index.js';
import { migrateTestDatabase, testDatabaseUrl } from '../test/setup.js';
import { accountFixture, activate, freshEvidence, order } from '../test/paper-fixtures.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('Paper 출처 경계', () => {
  let database: ReturnType<typeof createDatabase>;
  beforeAll(async () => {
    database = createDatabase(testDatabaseUrl());
    await migrateTestDatabase(database);
  }, 30000);
  afterAll(async () => {
    await database?.close();
  });

  it('출처를 영속화하며 기존 계좌의 출처 변경과 재생성을 거부한다', async () => {
    const { id, ledger } = await accountFixture(database);
    expect((await database.paper.readAccount(id)).source).toBe('synthetic-only');
    expect((await database.paper.readDashboard(id)).source).toBe('synthetic-only');
    await expect(database.paper.createAccount(id, ledger, 'toss-readonly')).rejects.toThrow('PAPER_SOURCE_MISMATCH');
    await expect(
      database.db.update(paperAccounts).set({ dataSource: 'toss-readonly' }).where(eq(paperAccounts.id, id)),
    ).rejects.toMatchObject({ cause: { code: '55000' } });
    expect((await database.paper.readAccount(id)).snapshot.cash).toEqual(ledger.cash);
  });
  it('미지정 출처는 미확인이고 raw SQL 재개도 차단한다', async () => {
    const fixture = await accountFixture(database);
    const id = `legacy-${randomUUID()}`;
    await database.paper.createAccount(id, fixture.ledger);
    expect((await database.paper.readDashboard(id)).source).toBe('unverified');
    await expect(database.paper.acquireLease(id)).rejects.toThrow('PAPER_SOURCE_MISMATCH');
    await expect(
      database.db.update(paperAccounts).set({ stopped: false }).where(eq(paperAccounts.id, id)),
    ).rejects.toMatchObject({ cause: { code: '55000' } });
    await database.paper.stop(id, 'DASHBOARD_EMERGENCY_STOP');
    expect((await database.paper.readAccount(id)).control.stopped).toBe(true);
  });
  it('다른 source worker의 lease/관측은 자산 변경 전에 거부한다', async () => {
    const { id } = await accountFixture(database);
    await expect(database.paper.acquireLease(id, 30000, 'toss-readonly')).rejects.toThrow('PAPER_SOURCE_MISMATCH');
    const lease = await database.paper.acquireLease(id);
    const before = await database.paper.readAccount(id);
    await expect(
      database.paper.observe(
        id,
        lease.token,
        lease.epoch,
        { quotes: [], sourcesHealthy: true, hasUnknownOrders: false },
        'toss-readonly',
      ),
    ).rejects.toThrow('PAPER_SOURCE_MISMATCH');
    expect((await database.paper.readAccount(id)).snapshot).toEqual(before.snapshot);
    await database.paper.releaseLease(id, lease.token, 'WORKER_FINISHED');
  });
  it('다른 출처의 의도/예약/체결을 거부하고 감사 기록만 남긴다', async () => {
    const { id } = await accountFixture(database);
    const lease = await activate(database, id);
    const evidence = await freshEvidence(database);
    const input = order(id, evidence);
    await expect(
      database.paper.recordIntent({ ...input, signal: { ...input.signal, source: 'toss' } }),
    ).rejects.toThrow('PAPER_SOURCE_MISMATCH');
    expect((await database.paper.readDashboard(id)).orders).toHaveLength(0);
    await database.paper.recordIntent(input);
    const mixed = structuredClone(evidence);
    mixed.marketData.candles[0]!.source = 'toss';
    const before = await database.paper.readAccount(id);
    await expect(database.paper.reserve(id, input.candidate.intentId, lease.token, mixed)).rejects.toThrow(
      'PAPER_SOURCE_MISMATCH',
    );
    expect((await database.paper.readAccount(id)).snapshot.reservations).toHaveLength(0);
    await database.paper.reserve(id, input.candidate.intentId, lease.token, evidence);
    await expect(
      database.paper.fill(id, input.candidate.intentId, lease.token, { fillId: randomUUID(), quantity: '1' }, mixed),
    ).rejects.toThrow('PAPER_SOURCE_MISMATCH');
    const after = await database.paper.readAccount(id);
    expect(after.snapshot.cash).toEqual(before.snapshot.cash);
    expect(after.snapshot.positions).toEqual(before.snapshot.positions);
    const dashboard = await database.paper.readDashboard(id);
    expect(dashboard.fills).toHaveLength(0);
    expect(dashboard.events.filter((event) => event.kind === 'SOURCE_REJECTED')).toHaveLength(3);
    await database.paper.releaseLease(id, lease.token, 'WORKER_FINISHED');
  });
  it('실제 시세 계좌는 toss 출처 의도만 받아들이며 합성 lease를 거부한다', async () => {
    const { id } = await accountFixture(database, '15000', [], 'toss-readonly');
    await expect(database.paper.acquireLease(id)).rejects.toThrow('PAPER_SOURCE_MISMATCH');
    const evidence = await freshEvidence(database);
    evidence.marketData.candles.forEach((candle) => {
      candle.source = 'toss';
    });
    await database.paper.recordIntent(order(id, evidence));
    expect((await database.paper.readDashboard(id)).source).toBe('toss-readonly');
    expect((await database.paper.readDashboard(id)).orders).toHaveLength(1);
  });
  it('repository를 우회한 다른 출처의 직접 SQL 의도 기록도 DB가 차단한다', async () => {
    const { id } = await accountFixture(database);
    const input = order(id, await freshEvidence(database));
    await expect(
      database.db.insert(paperIntents).values({
        accountId: id,
        intentId: input.candidate.intentId,
        candidate: input.candidate,
        signal: { ...input.signal, source: 'toss' },
        recordedEpoch: 0,
        dedupeKey: contentHash({ id, key: 'wrong-source' }),
        requestHash: contentHash(input),
      }),
    ).rejects.toMatchObject({ cause: { code: '55000' } });
    expect((await database.paper.readDashboard(id)).orders).toHaveLength(0);
  });
});
