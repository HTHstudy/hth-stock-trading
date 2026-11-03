import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { createDatabase, contentHash, paperEvents } from './index.js';
import { assertDedicatedPaperDatabase, testDatabaseUrl } from './test-database.js';
import { freshEvidence } from '../test/paper-fixtures.js';

// Existing dedicated test DB only; this suite never applies migrations.
describe.skipIf(!process.env.TEST_DATABASE_URL)('실행 구간 진단 읽기 전용 보관', () => {
  let database: ReturnType<typeof createDatabase>;
  beforeAll(async () => {
    database = createDatabase(testDatabaseUrl());
    await assertDedicatedPaperDatabase(database, testDatabaseUrl());
  });
  afterAll(async () => {
    await database?.close();
  });
  it('계좌 scope와 checkpoint 이벤트 집합을 확인하고 이후 진단을 섞지 않는다', async () => {
    const id = `paper-market-diag-test-${randomUUID()}`;
    const evidence = await freshEvidence(database);
    await database.paper.createAccount(
      id,
      {
        observedAt: evidence.quote.observedAt,
        reconciled: false,
        cash: { KRW: '1000', USD: '0' },
        positions: [],
        dailyPnl: { KRW: { tradingDate: '2026-11-03', netPnl: '0' }, USD: { tradingDate: '2026-11-03', netPnl: '0' } },
      },
      'toss-readonly',
    );
    const checkpoint = async () => {
      const snapshot = await database.paperReview.capture(id, 'toss-readonly');
      return { formatVersion: 'paper-review-checkpoint-v1', snapshot, hash: contentHash(snapshot) };
    };
    const before = await checkpoint();
    const now = (await database.db.execute<{ now: string }>(sql`SELECT clock_timestamp() AS now`)).rows[0]!.now;
    const batch = {
      formatVersion: 'paper-diagnostics-v1',
      recordedAt: new Date(now).toISOString(),
      source: 'toss-readonly',
      epoch: 0,
      accountVersion: 0,
      reports: [
        {
          strategyId: 'test-only',
          strategyVersion: '1',
          strategyRevision: 0,
          instrument: { market: 'KR', symbol: '005930' },
          evaluatedAt: new Date(now).toISOString(),
          stage: 'strategy',
          action: 'HOLD',
          codes: ['NO_CROSS'],
          closedCandles: 20,
          barAt: null,
          orderState: null,
        },
      ],
    };
    const eventId = randomUUID();
    await database.db.insert(paperEvents).values({
      id: eventId,
      accountId: id,
      kind: 'STRATEGY_DIAGNOSED',
      details: { batch, batchHash: contentHash(batch) },
    });
    const after = await checkpoint();
    await database.db
      .insert(paperEvents)
      .values({ accountId: id, kind: 'STRATEGY_DIAGNOSED', details: { batch, batchHash: contentHash(batch) } });
    const spy = vi.spyOn(database.db, 'transaction');
    try {
      const artifact = await database.paperReview.captureDiagnostics(id, before, after);
      expect(artifact.events).toHaveLength(1);
      expect(artifact.events[0]!.key).toBe(contentHash(eventId));
      expect(spy.mock.calls[0]?.[1]).toEqual({ isolationLevel: 'repeatable read', accessMode: 'read only' });
      expect(JSON.stringify(artifact)).not.toContain(id);
      const changed = structuredClone(after);
      changed.snapshot.scope = contentHash('other-account');
      changed.hash = contentHash(changed.snapshot);
      await expect(database.paperReview.captureDiagnostics(id, before, changed)).rejects.toThrow(
        'PAPER_REVIEW_SCOPE_INVALID',
      );
      const missing = structuredClone(after);
      missing.snapshot.events.push({
        key: contentHash('missing'),
        kind: 'STRATEGY_DIAGNOSED',
        createdAt: after.snapshot.asOf,
      });
      missing.hash = contentHash(missing.snapshot);
      await expect(database.paperReview.captureDiagnostics(id, before, missing)).rejects.toThrow(
        'PAPER_REVIEW_DIAGNOSTICS_MISSING',
      );
      const state = await checkpoint();
      await database.paperReview.captureDiagnostics(id, before, after);
      const unchanged = await checkpoint();
      expect(unchanged.snapshot).toEqual({ ...state.snapshot, asOf: expect.any(String) });
    } finally {
      spy.mockRestore();
    }
  });
});
