import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, paperAccounts, paperStrategies, paperStrategyRevisions } from './index.js';
import { migrateTestDatabase, testDatabaseUrl } from '../test/setup.js';
import { accountFixture } from '../test/paper-fixtures.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('전략 이력 조회', () => {
  let database: ReturnType<typeof createDatabase>;
  beforeAll(async () => {
    database = createDatabase(testDatabaseUrl());
    await migrateTestDatabase(database);
  }, 30000);
  afterAll(async () => {
    await database?.close();
  });
  const definition = {
    kind: 'moving-average-cross',
    instrument: { market: 'KR', symbol: '005930' },
    parameters: { fastPeriod: 2, slowPeriod: 5 },
    quantity: '1',
    maxFillQuantity: '1',
  } as const;
  it('이력 페이지와 같은 snapshot의 현재 설정을 반환하고 원장 상태를 바꾸지 않는다', async () => {
    const { id } = await accountFixture(database);
    for (let revision = 2; revision <= 25; revision++)
      await database.paper.updateStrategy(id, 'ma-a', {
        expectedRevision: revision - 1,
        enabled: revision % 2 === 0,
        definition,
      });
    const before = await database.paper.readAccount(id);
    const latest = await database.paper.readStrategyHistory(id, 'ma-a');
    expect(latest.strategy.revision).toBe(25);
    expect(latest.entries.map((item) => item.revision)).toEqual(Array.from({ length: 20 }, (_, i) => 25 - i));
    expect(latest.nextBeforeRevision).toBe(6);
    const older = await database.paper.readStrategyHistory(id, 'ma-a', { beforeRevision: 6 });
    expect(older.strategy).toEqual(latest.strategy);
    expect(older.entries.map((item) => item.revision)).toEqual([5, 4, 3, 2, 1]);
    expect(older.nextBeforeRevision).toBeNull();
    expect(older.entries.at(-1)).toMatchObject({ definition: null, actor: 'system' });
    expect(older.entries[0]!.actor).toBe('owner');
    expect(JSON.stringify(older)).not.toMatch(/accountId|valueHash|definitionHash|leaseToken/);
    expect((await database.paper.readAccount(id)).snapshot).toEqual(before.snapshot);
    expect((await database.paper.readAccount(id)).control).toEqual(before.control);
  });
  it('다른 계좌의 전략과 잘못된 cursor/계좌 주입을 거부한다', async () => {
    const first = await accountFixture(database);
    const second = await accountFixture(database);
    const account = await database.paper.readAccount(first.id);
    await database.paper.configureStrategy(first.id, account.snapshot.version, {
      id: 'only-first',
      version: '1.0.0',
      enabled: false,
    });
    await expect(database.paper.readStrategyHistory(second.id, 'only-first')).rejects.toThrow(
      'PAPER_STRATEGY_NOT_FOUND',
    );
    await expect(database.paper.readStrategyHistory(first.id, 'ma-a', { accountId: second.id })).rejects.toThrow(
      'PAPER_INPUT_INVALID',
    );
    await expect(database.paper.readStrategyHistory(first.id, 'ma-a', { beforeRevision: 0 })).rejects.toThrow(
      'PAPER_INPUT_INVALID',
    );
  });
  it('writer가 계좌 행을 잠근 동안에도 readonly snapshot을 조회한다', async () => {
    const { id } = await accountFixture(database);
    await database.db.transaction(async (transaction) => {
      await transaction.select().from(paperAccounts).where(eq(paperAccounts.id, id)).for('update');
      expect((await database.paper.readStrategyHistory(id, 'ma-a')).entries).toHaveLength(1);
    });
  });
  it('관리자 SQL로 만든 내용 hash 불일치를 과거 이력으로 노출하지 않는다', async () => {
    const { id } = await accountFixture(database);
    const [current] = await database.db
      .select()
      .from(paperStrategies)
      .where(and(eq(paperStrategies.accountId, id), eq(paperStrategies.strategyId, 'ma-a')));
    await database.db.transaction(async (transaction) => {
      await transaction
        .update(paperStrategies)
        .set({ revision: current!.revision + 1 })
        .where(and(eq(paperStrategies.accountId, id), eq(paperStrategies.strategyId, 'ma-a')));
      await transaction.insert(paperStrategyRevisions).values({
        accountId: id,
        strategyId: 'ma-a',
        revision: current!.revision + 1,
        version: current!.version,
        enabled: current!.enabled,
        definition: current!.definition,
        actor: 'system',
        valueHash: '0'.repeat(64),
      });
    });
    await expect(database.paper.readStrategyHistory(id, 'ma-a')).rejects.toThrow('PAPER_STRATEGY_HISTORY_INVALID');
  });
});
