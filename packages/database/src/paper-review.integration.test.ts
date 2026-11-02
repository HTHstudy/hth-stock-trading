import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDatabase, contentHash } from './index.js';
import { createPaperReviewStore } from './paper-review.js';
import { migrateTestDatabase, testDatabaseUrl } from '../test/setup.js';
import { accountFixture, activate, freshEvidence, order } from '../test/paper-fixtures.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('Paper 검토용 읽기 전용 snapshot', () => {
  let database: ReturnType<typeof createDatabase>;
  beforeAll(async () => {
    database = createDatabase(testDatabaseUrl());
    await migrateTestDatabase(database);
  }, 30000);
  afterAll(async () => {
    await database?.close();
  });
  it('요청/체결 hash를 확인하고 비공개 식별자·lease·원본 감사 자료를 반환하지 않는다', async () => {
    const { id } = await accountFixture(database);
    const lease = await activate(database, id);
    const evidence = await freshEvidence(database),
      input = order(id, evidence, 'ma-a', '2');
    await database.paper.recordIntent(input);
    await database.paper.reserve(id, input.candidate.intentId, lease.token, evidence);
    const fillId = randomUUID();
    await database.paper.fill(
      id,
      input.candidate.intentId,
      lease.token,
      { fillId, quantity: '1' },
      await freshEvidence(database),
    );
    await database.paper.releaseLease(id, lease.token, 'WORKER_FINISHED');
    const before = await database.paper.readDashboard(id);
    const transaction = vi.spyOn(database.db, 'transaction');
    try {
      const snapshot = await database.paperReview.capture(id, 'synthetic-only');
      expect(transaction.mock.calls[0]?.[1]).toEqual({ isolationLevel: 'repeatable read', accessMode: 'read only' });
      expect(snapshot.intents[0]).toMatchObject({
        key: contentHash(input.candidate.intentId),
        requestVerified: true,
        dedupeVerified: true,
      });
      expect(snapshot.fills[0]).toMatchObject({ key: contentHash(fillId), requestVerified: true });
      expect(snapshot.fills[0]!.createdAt).toMatch(/\.\d{6}Z$/);
      const serialized = JSON.stringify(snapshot);
      for (const secret of [
        id,
        lease.token,
        fillId,
        input.candidate.intentId,
        testDatabaseUrl(),
        'candidate',
        'decision',
        'details',
        'leaseToken',
      ])
        expect(serialized).not.toContain(secret);
      const changedPassword = new URL(testDatabaseUrl());
      changedPassword.password = 'not-used-for-connection';
      expect(
        (await createPaperReviewStore(database.db, changedPassword.href).capture(id, 'synthetic-only')).scope,
      ).toBe(snapshot.scope);
      expect(await database.paper.readDashboard(id)).toEqual({ ...before, asOf: expect.any(String) });
    } finally {
      transaction.mockRestore();
    }
  });
  it('다른 계좌·출처·미확인 계좌를 정상 자료로 섞지 않는다', async () => {
    const one = await accountFixture(database),
      two = await accountFixture(database);
    const a = await database.paperReview.capture(one.id, 'synthetic-only'),
      b = await database.paperReview.capture(two.id, 'synthetic-only');
    expect(a.scope).not.toBe(b.scope);
    await expect(database.paperReview.capture(one.id, 'toss-readonly')).rejects.toThrow('PAPER_REVIEW_SCOPE_INVALID');
    await expect(database.paperReview.capture('missing-' + randomUUID(), 'synthetic-only')).rejects.toThrow(
      'PAPER_REVIEW_SCOPE_INVALID',
    );
    const legacy = 'paper-' + randomUUID();
    await database.paper.createAccount(legacy, one.ledger);
    await expect(database.paperReview.capture(legacy, 'synthetic-only')).rejects.toThrow('PAPER_REVIEW_SCOPE_INVALID');
  });
  it('5000개를 넘는 이력은 조용히 잘라서 완성된 snapshot으로 내보내지 않는다', async () => {
    const { id } = await accountFixture(database);
    await database.db.execute(
      sql`INSERT INTO paper_events(account_id, kind, details) SELECT ${id}, 'LIMIT_NOT_REACHED', '{}'::jsonb FROM generate_series(1,5001)`,
    );
    await expect(database.paperReview.capture(id, 'synthetic-only')).rejects.toThrow('PAPER_REVIEW_LIMIT_EXCEEDED');
  });
});
