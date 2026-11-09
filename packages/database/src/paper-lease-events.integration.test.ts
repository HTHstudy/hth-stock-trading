import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { contentHash, createDatabase } from './index.js';
import { migrateTestDatabase, testDatabaseUrl } from '../test/setup.js';
import { accountFixture, freshEvidence, order } from '../test/paper-fixtures.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('Paper lease/resume 이벤트 hash CAS', () => {
  let database: ReturnType<typeof createDatabase>;
  let contender: ReturnType<typeof createDatabase>;
  const network = vi.fn<typeof fetch>();
  beforeAll(async () => {
    const url = testDatabaseUrl();
    database = createDatabase(url);
    contender = createDatabase(url);
    await migrateTestDatabase(database);
  }, 30000);
  beforeEach(() => {
    network.mockReset().mockRejectedValue(new Error('NETWORK_FORBIDDEN'));
    vi.spyOn(globalThis, 'fetch').mockImplementation(network);
  });
  afterEach(() => {
    try {
      expect(network).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });
  afterAll(async () => {
    await Promise.all([database?.close(), contender?.close()]);
  });

  const capture = (id: string) => database.paperReview.capture(id, 'synthetic-only');
  async function rejectedEvent(id: string) {
    const input = order(id, await freshEvidence(contender));
    await expect(
      contender.paper.recordIntent({ ...input, signal: { ...input.signal, source: 'toss' } }),
    ).rejects.toThrow('PAPER_SOURCE_MISMATCH');
  }
  async function resumeFixture() {
    const { id } = await accountFixture(database);
    const lease = await database.paper.acquireLease(id);
    try {
      await database.paper.recoverLease(id, lease.token, lease.epoch);
      const view = await database.paper.readAccount(id);
      const evidence = await freshEvidence(database);
      await database.paper.reconcile(id, lease.token, view.snapshot.version, {
        observedAt: evidence.quote.observedAt,
        marks: [],
        dailyPnl: view.snapshot.dailyPnl,
        acknowledgement: 'PAPER_RECONCILED',
      });
      return { id, lease };
    } catch (error) {
      await database.paper.releaseLease(id, lease.token, 'TEST_CLEANUP');
      throw error;
    }
  }

  it('capture 이후 version 없는 거부 이벤트가 추가되면 guarded acquireLease를 거부하고 변경하지 않는다', async () => {
    const { id } = await accountFixture(database);
    const before = await capture(id);
    await rejectedEvent(id);
    const changed = await capture(id);
    expect(changed.version).toBe(before.version);
    expect(changed.epoch).toBe(before.epoch);
    expect(changed.events).toHaveLength(before.events.length + 1);
    expect(changed.events.some((event) => event.kind === 'SOURCE_REJECTED')).toBe(true);
    expect(changed.cash).toEqual(before.cash);
    expect(changed.intents).toEqual(before.intents);
    await expect(
      database.paper.acquireLease(id, 30000, 'synthetic-only', before.version, contentHash(before.events)),
    ).rejects.toThrow('PAPER_VERSION_CONFLICT');
    expect(await capture(id)).toEqual({ ...changed, asOf: expect.any(String) });
  });

  it('동일한 snapshot.events hash이면 guarded acquireLease를 허용한다', async () => {
    const { id } = await accountFixture(database);
    const before = await capture(id);
    const lease = await database.paper.acquireLease(
      id,
      30000,
      'synthetic-only',
      before.version,
      contentHash(before.events),
    );
    try {
      const after = await capture(id);
      expect(after).toMatchObject({ version: before.version + 1, epoch: before.epoch + 1, leasePresent: true });
      expect(after.events.filter((event) => event.kind === 'LEASE_ACQUIRED')).toHaveLength(1);
    } finally {
      await database.paper.releaseLease(id, lease.token, 'TEST_CLEANUP');
    }
  });

  it('expectedEventsHash 생략 시 version 없는 이벤트가 있어도 기존 acquireLease 동작을 유지한다', async () => {
    const { id } = await accountFixture(database);
    const before = await capture(id);
    await rejectedEvent(id);
    const lease = await database.paper.acquireLease(id, 30000, 'synthetic-only', before.version);
    try {
      expect((await capture(id)).leasePresent).toBe(true);
    } finally {
      await database.paper.releaseLease(id, lease.token, 'TEST_CLEANUP');
    }
  });

  it('lease 이후 frame I/O 구간의 version 없는 거부 이벤트가 추가되면 guarded resume를 거부한다', async () => {
    const { id, lease } = await resumeFixture();
    try {
      const before = await capture(id);
      await rejectedEvent(id);
      const changed = await capture(id);
      expect(changed.version).toBe(before.version);
      expect(changed.epoch).toBe(before.epoch);
      expect(changed.events).toHaveLength(before.events.length + 1);
      await expect(database.paper.resume(id, lease.token, before.version, contentHash(before.events))).rejects.toThrow(
        'PAPER_VERSION_CONFLICT',
      );
      expect(await capture(id)).toEqual({ ...changed, asOf: expect.any(String) });
      expect(changed.stopped).toBe(true);
      expect(changed.events.some((event) => event.kind === 'PAPER_RESUMED')).toBe(false);
    } finally {
      await database.paper.releaseLease(id, lease.token, 'TEST_CLEANUP');
    }
  });

  it('동일한 snapshot.events hash이면 guarded resume를 허용한다', async () => {
    const { id, lease } = await resumeFixture();
    try {
      const before = await capture(id);
      await database.paper.resume(id, lease.token, before.version, contentHash(before.events));
      const after = await capture(id);
      expect(after).toMatchObject({ version: before.version + 1, epoch: before.epoch + 1, stopped: false });
      expect(after.events.filter((event) => event.kind === 'PAPER_RESUMED')).toHaveLength(1);
    } finally {
      await database.paper.releaseLease(id, lease.token, 'TEST_CLEANUP');
    }
  });

  it('expectedEventsHash 생략 시 version 없는 이벤트가 있어도 기존 resume 동작을 유지한다', async () => {
    const { id, lease } = await resumeFixture();
    try {
      const before = await capture(id);
      await rejectedEvent(id);
      await database.paper.resume(id, lease.token, before.version);
      expect((await capture(id)).stopped).toBe(false);
    } finally {
      await database.paper.releaseLease(id, lease.token, 'TEST_CLEANUP');
    }
  });
});
