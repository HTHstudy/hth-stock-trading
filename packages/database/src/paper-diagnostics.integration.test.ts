import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import type { PaperDiagnosticReport } from '@hth/contracts';
import { createDatabase, paperEvents } from './index.js';
import { migrateTestDatabase, testDatabaseUrl } from '../test/setup.js';
import { accountFixture, activate } from '../test/paper-fixtures.js';
describe.skipIf(!process.env.TEST_DATABASE_URL)('Paper 저장 진단', () => {
  let database: ReturnType<typeof createDatabase>;
  beforeAll(async () => {
    database = createDatabase(testDatabaseUrl());
    await migrateTestDatabase(database);
  }, 30000);
  afterAll(async () => {
    await database?.close();
  });
  async function fixture() {
    const { id } = await accountFixture(database);
    const lease = await activate(database, id);
    const current = await database.paper.readAccount(id);
    const report: PaperDiagnosticReport = {
      strategyId: 'ma-a',
      strategyVersion: '1.0.0',
      strategyRevision: 1,
      instrument: { market: 'KR', symbol: '005930' },
      evaluatedAt: current.asOf,
      stage: 'strategy',
      action: 'HOLD',
      codes: ['NO_CROSS'],
      closedCandles: 10,
      barAt: null,
      orderState: null,
    };
    return { id, lease, epoch: current.control.epoch, report };
  }
  it('고정 계좌의 실제 저장 결과만 읽고 조회로 원장/제어를 바꾸지 않는다', async () => {
    const { id, lease, epoch, report } = await fixture();
    expect((await database.paper.readDiagnostics(id)).items.every((item) => item.latest === null)).toBe(true);
    const before = await database.paper.readAccount(id);
    await database.paper.recordDiagnostics(id, lease.token, epoch, 'synthetic-only', [report]);
    const result = await database.paper.readDiagnostics(id);
    expect(result.items[0]).toMatchObject({ latest: { report }, configurationCurrent: true, stale: false });
    expect(result.items[1]!.latest).toBeNull();
    expect(JSON.stringify(result)).not.toMatch(/accountId|batchHash|leaseToken|accountVersion/);
    expect((await database.paper.readAccount(id)).snapshot).toEqual(before.snapshot);
    expect((await database.paper.readAccount(id)).control).toEqual(before.control);
    const other = await accountFixture(database);
    expect((await database.paper.readDiagnostics(other.id)).items.every((item) => item.latest === null)).toBe(true);
    await expect(
      database.db.update(paperEvents).set({ details: {} }).where(eq(paperEvents.accountId, id)),
    ).rejects.toThrow();
    await database.paper.releaseLease(id, lease.token, 'TEST_DONE');
  });
  it('다른 소유권·출처·리비전·비공개 필드를 거부하고 변경된 현재 설정과 과거 진단을 구분한다', async () => {
    const { id, lease, epoch, report } = await fixture();
    await expect(
      database.paper.recordDiagnostics(id, randomUUID(), epoch, 'synthetic-only', [report]),
    ).rejects.toThrow();
    await expect(database.paper.recordDiagnostics(id, lease.token, epoch, 'toss-readonly', [report])).rejects.toThrow(
      'PAPER_SOURCE_MISMATCH',
    );
    await expect(
      database.paper.recordDiagnostics(id, lease.token, epoch, 'synthetic-only', [{ ...report, strategyRevision: 99 }]),
    ).rejects.toThrow('PAPER_DIAGNOSTIC_MISMATCH');
    await expect(
      database.paper.recordDiagnostics(id, lease.token, epoch, 'synthetic-only', [{ ...report, raw: 'PRIVATE' }]),
    ).rejects.toThrow('PAPER_INPUT_INVALID');
    await database.paper.recordDiagnostics(id, lease.token, epoch, 'synthetic-only', [report]);
    await database.paper.updateStrategy(id, 'ma-a', {
      expectedRevision: 1,
      enabled: false,
      definition: {
        kind: 'moving-average-cross',
        instrument: { market: 'KR', symbol: '005930' },
        parameters: { fastPeriod: 5, slowPeriod: 20 },
        quantity: '1',
        maxFillQuantity: '1',
      },
    });
    expect((await database.paper.readDiagnostics(id)).items[0]).toMatchObject({
      configurationCurrent: false,
      latest: { report: { strategyRevision: 1 } },
      strategy: { revision: 2, enabled: false },
    });
    await database.paper.releaseLease(id, lease.token, 'TEST_DONE');
  });
  it('내용 hash 불일치를 정상 진단으로 반환하지 않는다', async () => {
    const { id, lease, epoch, report } = await fixture();
    await database.paper.recordDiagnostics(id, lease.token, epoch, 'synthetic-only', [report]);
    const good = (await database.db.select().from(paperEvents).where(eq(paperEvents.accountId, id))).find(
      (row) => row.kind === 'STRATEGY_DIAGNOSED',
    )!;
    await database.db
      .insert(paperEvents)
      .values({ accountId: id, kind: 'STRATEGY_DIAGNOSED', details: { ...good.details, batchHash: '0'.repeat(64) } });
    await expect(database.paper.readDiagnostics(id)).rejects.toThrow();
    await database.paper.releaseLease(id, lease.token, 'TEST_DONE');
  });
  it('최근 20묶음 밖의 전략 결과는 추정하지 않고 조회 범위 제한을 표시한다', async () => {
    const { id, lease, epoch, report } = await fixture();
    await database.paper.recordDiagnostics(id, lease.token, epoch, 'synthetic-only', [
      { ...report, strategyId: 'ma-b' },
    ]);
    for (let index = 0; index < 20; index++)
      await database.paper.recordDiagnostics(id, lease.token, epoch, 'synthetic-only', [report]);
    const value = await database.paper.readDiagnostics(id);
    expect(value.limited).toBe(true);
    expect(value.items[0]!.latest).not.toBeNull();
    expect(value.items[1]!.latest).toBeNull();
    await database.paper.releaseLease(id, lease.token, 'TEST_DONE');
  });
});
