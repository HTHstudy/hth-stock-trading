import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDatabase } from '@hth/database';
import { migrateTestDatabase, testDatabaseUrl } from '@hth/database/testing';
import { rehearsePaper } from './paper-rehearsal.js';

const plan = JSON.parse(readFileSync(new URL('../../../examples/paper-rehearsal-plan.json', import.meta.url), 'utf8'));
describe.skipIf(!process.env.TEST_DATABASE_URL)('격리된 Paper 통합 리허설', () => {
  let database: ReturnType<typeof createDatabase>;
  beforeAll(async () => {
    database = createDatabase(testDatabaseUrl());
    await migrateTestDatabase(database);
  }, 30_000);
  afterAll(async () => {
    await database?.close();
  });
  it('외부 통신 없이 두 시장의 체결/복구/보호/진단을 같은 결과로 재현한다', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('NETWORK_FORBIDDEN'));
    const first = await rehearsePaper(database, plan, new AbortController().signal);
    const second = await rehearsePaper(database, plan, new AbortController().signal);
    expect(second).toEqual(first);
    expect(first.checks).toHaveLength(26);
    expect(first.checks.every((check) => check.passed)).toBe(true);
    expect(first.outcomes.map((outcome) => outcome.cash)).toEqual(['14591', '145.91']);
    expect(network).not.toHaveBeenCalled();
    const leases = await database.db.$client.query(
      "SELECT count(*)::int AS count FROM paper_accounts WHERE id LIKE 'paper-rehearsal-%' AND lease_until IS NOT NULL",
    );
    expect(leases.rows[0].count).toBe(0);
  }, 30_000);
  it('검증 실패 후에도 worker lease를 정리하고 취소된 실행은 시작하지 않는다', async () => {
    const wrong = structuredClone(plan);
    wrong.profiles[0].expectedRoundTrip.cash = '1';
    await expect(rehearsePaper(database, wrong, new AbortController().signal)).rejects.toThrow(
      'PAPER_REHEARSAL_ASSERTION_FAILED',
    );
    const controller = new AbortController();
    controller.abort();
    await expect(rehearsePaper(database, plan, controller.signal)).rejects.toThrow();
    const leases = await database.db.$client.query(
      "SELECT count(*)::int AS count FROM paper_accounts WHERE id LIKE 'paper-rehearsal-%' AND lease_until IS NOT NULL",
    );
    expect(leases.rows[0].count).toBe(0);
  }, 30_000);
});
