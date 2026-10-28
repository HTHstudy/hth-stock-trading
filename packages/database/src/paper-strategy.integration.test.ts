import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, paperStrategyRevisions, paperStrategies } from './index.js';
import { migrateTestDatabase, testDatabaseUrl } from '../test/setup.js';
import { accountFixture, activate, freshEvidence, order } from '../test/paper-fixtures.js';

const definition = {
  kind: 'moving-average-cross',
  instrument: { market: 'KR', symbol: '005930' },
  parameters: { fastPeriod: 1, slowPeriod: 2 },
  quantity: '10',
  maxFillQuantity: '2',
} as const;
describe.skipIf(!process.env.TEST_DATABASE_URL)('Paper 전략의 영속 설정과 변경 이력', () => {
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
  it('변경은 실행을 정지시키고 기존 부분 체결·소유권을 보존한다', async () => {
    const { id } = await accountFixture(database);
    const lease = await activate(database, id);
    const evidence = await freshEvidence(database);
    const input = order(id, evidence);
    await database.paper.recordIntent(input);
    await database.paper.reserve(id, input.candidate.intentId, lease.token, evidence);
    await database.paper.fill(
      id,
      input.candidate.intentId,
      lease.token,
      { fillId: randomUUID(), quantity: '4' },
      await freshEvidence(database),
    );
    const before = await database.paper.readAccount(id);
    const updated = await database.paper.updateStrategy(id, 'ma-a', { expectedRevision: 1, enabled: true, definition });
    expect(updated).toMatchObject({ revision: 2, definition });
    expect(await database.paper.readAccount(id)).toMatchObject({
      control: { stopped: true, epoch: before.control.epoch + 1 },
      snapshot: { cash: { KRW: '10996' }, positions: [{ quantity: '4' }] },
    });
    await expect(
      database.paper.fill(
        id,
        input.candidate.intentId,
        lease.token,
        { fillId: randomUUID(), quantity: '1' },
        await freshEvidence(database),
      ),
    ).rejects.toThrow('PAPER_RESERVATION_STALE');
    expect(
      (await database.paper.readDashboard(id)).strategies.find((strategy) => strategy.id === 'ma-a'),
    ).toMatchObject({ revision: 2, definition });
  });
  it('같은 리비전의 동시 저장은 하나만 커밋하고 마지막 저장으로 덮어쓰지 않는다', async () => {
    const { id } = await accountFixture(database);
    const result = await Promise.allSettled([
      database.paper.updateStrategy(id, 'ma-a', { expectedRevision: 1, enabled: true, definition }),
      contender.paper.updateStrategy(id, 'ma-a', {
        expectedRevision: 1,
        enabled: false,
        definition: { ...definition, quantity: '11' },
      }),
    ]);
    expect(result.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(result.find((item) => item.status === 'rejected')).toMatchObject({
      reason: new Error('PAPER_STRATEGY_REVISION_CONFLICT'),
    });
    const history = await database.db
      .select()
      .from(paperStrategyRevisions)
      .where(and(eq(paperStrategyRevisions.accountId, id), eq(paperStrategyRevisions.strategyId, 'ma-a')));
    expect(history).toHaveLength(2);
    expect(history.filter((item) => item.actor === 'owner')).toHaveLength(1);
  });
  it('정의·리비전 hash와 최대 체결 수량을 예약·체결 단계에서 다시 검사한다', async () => {
    for (const forged of [true, false]) {
      const { id } = await accountFixture(database);
      await database.paper.updateStrategy(id, 'ma-a', { expectedRevision: 1, enabled: true, definition });
      const lease = await activate(database, id);
      const evidence = await freshEvidence(database);
      const strategy = (await database.paper.readStrategies(id)).find((item) => item.id === 'ma-a')!;
      const input = {
        ...order(id, evidence),
        signal: {
          ...order(id, evidence).signal,
          strategyRevision: strategy.revision,
          configHash: forged ? '0'.repeat(64) : strategy.definitionHash!,
        },
      };
      await database.paper.recordIntent(input);
      const reserved = await database.paper.reserve(id, input.candidate.intentId, lease.token, evidence);
      if (forged) expect(reserved.intent.codes).toContain('SIGNAL_NOT_CURRENT');
      else {
        expect(reserved.intent.state).toBe('READY');
        await expect(
          database.paper.fill(
            id,
            input.candidate.intentId,
            lease.token,
            { fillId: randomUUID(), quantity: '3' },
            await freshEvidence(database),
          ),
        ).rejects.toThrow('PAPER_STRATEGY_CONFIG_MISMATCH');
        expect(
          (
            await database.paper.fill(
              id,
              input.candidate.intentId,
              lease.token,
              { fillId: randomUUID(), quantity: '2' },
              await freshEvidence(database),
            )
          ).fill!.quantity,
        ).toBe('2');
      }
    }
  });
  it('설정 이력은 수정·삭제할 수 없고 현재 설정과 일치해야 한다', async () => {
    const { id } = await accountFixture(database);
    await expect(
      database.db.delete(paperStrategyRevisions).where(eq(paperStrategyRevisions.accountId, id)),
    ).rejects.toMatchObject({ cause: { code: '55000' } });
    await expect(
      database.db.update(paperStrategies).set({ enabled: false }).where(eq(paperStrategies.accountId, id)),
    ).rejects.toMatchObject({ cause: { code: '55000' } });
    await expect(
      database.db.insert(paperStrategyRevisions).values({
        accountId: id,
        strategyId: 'ma-a',
        revision: 2,
        version: '1.0.0',
        enabled: false,
        definition,
        valueHash: 'a'.repeat(64),
        actor: 'owner',
      }),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });
  it('비활성·재활성화로 같은 봉의 주문을 새로 생성하지 않는다', async () => {
    const { id } = await accountFixture(database);
    await database.paper.updateStrategy(id, 'ma-a', { expectedRevision: 1, enabled: true, definition });
    const lease = await activate(database, id);
    const evidence = await freshEvidence(database);
    const stored = (await database.paper.readStrategies(id)).find((strategy) => strategy.id === 'ma-a')!;
    const original = order(id, evidence);
    const input = {
      ...original,
      signal: { ...original.signal, strategyRevision: stored.revision, configHash: stored.definitionHash! },
    };
    await database.paper.recordIntent(input);
    await database.paper.reserve(id, input.candidate.intentId, lease.token, evidence);
    await database.paper.updateStrategy(id, 'ma-a', { expectedRevision: 2, enabled: false, definition });
    await database.paper.updateStrategy(id, 'ma-a', { expectedRevision: 3, enabled: true, definition });
    await database.paper.releaseLease(id, lease.token, 'TEST_COMPLETE');
    await expect(
      database.paper.recordIntent({
        candidate: { ...input.candidate, intentId: randomUUID() },
        signal: { ...input.signal, strategyRevision: 4 },
      }),
    ).rejects.toThrow('PAPER_INTENT_CONFLICT');
    expect(await database.paper.readOpenIntents(id)).toHaveLength(0);
  });
  it('이력 저장 장애는 설정·정지 epoch까지 함께 롤백한다', async () => {
    const { id } = await accountFixture(database);
    await activate(database, id);
    const before = await database.paper.readAccount(id);
    await database.db.execute(
      sql`CREATE FUNCTION fail_strategy_history_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.account_id = TG_ARGV[0] THEN RAISE EXCEPTION 'TEST_FAULT'; END IF; RETURN NEW; END; $$`,
    );
    await database.db.execute(
      sql`CREATE TRIGGER fail_strategy_history_test BEFORE INSERT ON paper_strategy_revisions FOR EACH ROW EXECUTE FUNCTION fail_strategy_history_test(${sql.raw(`'${id}'`)})`,
    );
    try {
      await expect(
        database.paper.updateStrategy(id, 'ma-a', { expectedRevision: 1, enabled: false, definition }),
      ).rejects.toThrow('PAPER_STORAGE_FAILED');
    } finally {
      await database.db.execute(sql`DROP TRIGGER fail_strategy_history_test ON paper_strategy_revisions`);
      await database.db.execute(sql`DROP FUNCTION fail_strategy_history_test()`);
    }
    expect((await database.paper.readAccount(id)).control).toEqual(before.control);
    expect((await database.paper.readStrategies(id)).find((strategy) => strategy.id === 'ma-a')).toMatchObject({
      revision: 1,
      enabled: true,
      definition: null,
    });
  });
});
