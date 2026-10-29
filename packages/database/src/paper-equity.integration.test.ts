import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { createDatabase, paperEvents, paperAccounts, contentHash } from './index.js';
import { migrateTestDatabase, testDatabaseUrl } from '../test/setup.js';
import { accountFixture, activate, freshEvidence, order } from '../test/paper-fixtures.js';
describe.skipIf(!process.env.TEST_DATABASE_URL)('Paper 평가 이력', () => {
  let database: ReturnType<typeof createDatabase>;
  beforeAll(async () => {
    database = createDatabase(testDatabaseUrl());
    await migrateTestDatabase(database);
  }, 30000);
  afterAll(async () => {
    await database?.close();
  });
  it('과거 원장은 추정하지 않고 계좌별 빈 이력을 반환한다', async () => {
    const { id } = await accountFixture(database);
    await database.db.insert(paperEvents).values({ accountId: id, kind: 'ACCOUNT_OBSERVED', details: {} });
    expect(await database.paper.readEquityHistory(id)).toMatchObject({ baseline: null, points: [], limited: false });
  });
  it('부분 체결 비용을 같은 트랜잭션에 기록하고 조회로 원장을 바꾸지 않는다', async () => {
    const { id } = await accountFixture(database);
    const lease = await activate(database, id);
    const input = order(id, await freshEvidence(database));
    await database.paper.recordIntent(input);
    await database.paper.reserve(id, input.candidate.intentId, lease.token, await freshEvidence(database));
    const request = { fillId: randomUUID(), quantity: '4' };
    await database.paper.fill(id, input.candidate.intentId, lease.token, request, await freshEvidence(database));
    const before = await database.paper.readAccount(id);
    const history = await database.paper.readEquityHistory(id);
    expect(history.baseline!.values[0].equity).toBe('15000');
    expect(history.points.at(-1)).toMatchObject({
      point: {
        values: [
          { currency: 'KRW', equity: '14996' },
          { currency: 'USD', equity: '1000' },
        ],
      },
      changePercent: ['-0.02666667', '0.00000000'],
    });
    await database.paper.fill(id, input.candidate.intentId, lease.token, request, await freshEvidence(database));
    expect((await database.paper.readEquityHistory(id)).points).toEqual(history.points);
    expect((await database.paper.readAccount(id)).snapshot).toEqual(before.snapshot);
    expect((await database.paper.readAccount(id)).control).toEqual(before.control);
    expect(JSON.stringify(history)).not.toMatch(/accountId|equityHash|leaseToken/);
    const other = await accountFixture(database);
    expect((await database.paper.readEquityHistory(other.id)).points).toHaveLength(0);
    await expect(
      database.db.update(paperEvents).set({ details: {} }).where(eq(paperEvents.accountId, id)),
    ).rejects.toThrow();
    await database.paper.releaseLease(id, lease.token, 'TEST_DONE');
  });
  it('최근 500개를 버전순으로 읽어도 기준은 최초 기록을 보존한다', async () => {
    const { id } = await accountFixture(database);
    await database.db.update(paperAccounts).set({ version: 1000 }).where(eq(paperAccounts.id, id));
    const now = new Date().toISOString();
    await database.db.insert(paperEvents).values(
      Array.from({ length: 501 }, (_, index) => {
        const equityPoint = {
          formatVersion: 'paper-equity-v1',
          version: index + 1,
          source: 'synthetic-only',
          recordedAt: now,
          observedAt: now,
          reconciled: true,
          stale: false,
          values: [
            { currency: 'KRW', equity: String(100 + index) },
            { currency: 'USD', equity: '0' },
          ],
        };
        return {
          accountId: id,
          kind: 'ACCOUNT_OBSERVED',
          details: { equityPoint, equityHash: contentHash(equityPoint) },
        };
      }),
    );
    const history = await database.paper.readEquityHistory(id);
    expect(history.limited).toBe(true);
    expect(history.points).toHaveLength(500);
    expect(history.baseline!.version).toBe(1);
    expect(history.points[0]!.point.version).toBe(2);
    expect(history.points.at(-1)!.changePercent).toEqual(['500.00000000', null]);
  });
  it('내용 hash가 불일치하면 평가값을 제공하지 않는다', async () => {
    const { id } = await accountFixture(database);
    const now = new Date().toISOString();
    const equityPoint = {
      formatVersion: 'paper-equity-v1',
      version: 1,
      source: 'synthetic-only',
      recordedAt: now,
      observedAt: now,
      reconciled: true,
      stale: false,
      values: [
        { currency: 'KRW', equity: '15000' },
        { currency: 'USD', equity: '1000' },
      ],
    };
    await database.db
      .insert(paperEvents)
      .values({ accountId: id, kind: 'ACCOUNT_OBSERVED', details: { equityPoint, equityHash: '0'.repeat(64) } });
    await expect(database.paper.readEquityHistory(id)).rejects.toThrow('PAPER_EQUITY_HISTORY_INVALID');
  });
});
