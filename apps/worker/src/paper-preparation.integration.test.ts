import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { contentHash, createDatabase } from '@hth/database';
import { migrateTestDatabase, testDatabaseUrl } from '@hth/database/testing';
import { readPaperMarketPlan } from './paper-market-plan.js';
import { checkPaperPreparation, runPaperPreparation } from './paper-preparation.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('broker 없는 실제 시세 Paper 계좌 준비', () => {
  let db: ReturnType<typeof createDatabase>;
  beforeAll(async () => {
    db = createDatabase(testDatabaseUrl());
    await migrateTestDatabase(db);
  }, 30_000);
  afterAll(async () => {
    await db?.close();
  });
  const id = () => 'paper-market-' + randomUUID();
  async function argumentsFor(account: string, market = 'kr') {
    const path = `examples/paper-market-${market}-validation-v1.json`;
    const plan = await readPaperMarketPlan(path);
    return { plan, args: ['--plan=' + path, '--plan-hash=' + contentHash(plan), '--account=' + account] };
  }
  async function prepare(account: string, market = 'kr') {
    const { plan, args } = await argumentsFor(account, market);
    const report = await runPaperPreparation([...args, '--apply'], { PAPER_MARKET_DATABASE_URL: testDatabaseUrl() });
    return { plan, args, report };
  }
  it('KR/US 계획을 원자적으로 저장하고 주문·lease·시장 관측 없이 정지한다', async () => {
    const fetch = vi.fn(() => {
      throw new Error('NO_HTTP_ALLOWED');
    });
    vi.stubGlobal('fetch', fetch);
    try {
      for (const market of ['kr', 'us']) {
        const account = id();
        const { report } = await prepare(account, market);
        expect(report).toMatchObject({
          state: 'prepared-stopped',
          preparationMatches: true,
          canResume: false,
          marketReadiness: 'not-checked',
          executionEnabled: false,
        });
        expect(JSON.stringify(report)).not.toContain(account);
        const stored = await db.paperPreparation.read(account);
        expect(stored.account).toMatchObject({
          version: 0,
          epoch: 0,
          stopped: true,
          leaseToken: null,
          leaseUntil: null,
          ledger: { reconciled: false, positions: [] },
        });
        expect(stored.counts).toEqual({ orders: '0', fills: '0', reservations: '0' });
      }
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('check는 같은 snapshot의 설정·이력을 검사하고 원장을 변경하지 않는다', async () => {
    const account = id();
    const { args } = await prepare(account);
    const before = await db.paperPreparation.read(account);
    const result = await runPaperPreparation([...args, '--check'], { PAPER_MARKET_DATABASE_URL: testDatabaseUrl() });
    expect(result).toMatchObject({ state: 'checked', preparationMatches: true, canResume: false });
    expect(await db.paperPreparation.read(account)).toEqual(before);
  });
  it('같은 계좌의 경합 초기화는 하나만 성공하고 기존 자금·설정을 덮어쓰지 않는다', async () => {
    const account = id();
    const { args } = await argumentsFor(account);
    const operation = () => runPaperPreparation([...args, '--apply'], { PAPER_MARKET_DATABASE_URL: testDatabaseUrl() });
    const results = await Promise.allSettled([operation(), operation()]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const before = await db.paperPreparation.read(account);
    await expect(operation()).rejects.toThrow('PAPER_MARKET_ACCOUNT_EXISTS');
    expect(await db.paperPreparation.read(account)).toEqual(before);
  });
  it('계획·전략·준비 영수증 불일치를 숨기거나 현재 값으로 복원하지 않는다', async () => {
    const account = id();
    const { plan } = await prepare(account);
    const before = await db.paperPreparation.read(account);
    const changed = structuredClone(plan);
    changed.limits.maxPositions = 2;
    expect(checkPaperPreparation(changed, before)).toMatchObject({
      preparationMatches: false,
      checks: { limitsMatch: false, preparationReceipt: false },
    });
    await db.paper.updateStrategy(account, 'market-ma', {
      expectedRevision: 1,
      enabled: false,
      definition: plan.strategy,
    });
    const updated = await db.paperPreparation.read(account);
    expect(checkPaperPreparation(plan, updated)).toMatchObject({
      preparationMatches: false,
      checks: { initialControl: false, strategyMatches: false, historyMatches: false },
    });
    expect(updated.account.ledger).toEqual(before.account.ledger);
  });
  it('감사 기록 저장 실패는 계좌·한도·전략·이력 전체를 롤백한다', async () => {
    const account = id();
    const name = 'fail_prep_' + randomUUID().replaceAll('-', '');
    await db.db.$client.query(
      `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.account_id = '${account}' THEN RAISE EXCEPTION 'FAIL_PREPARATION'; END IF; RETURN NEW; END; $$; CREATE TRIGGER ${name} BEFORE INSERT ON paper_events FOR EACH ROW EXECUTE FUNCTION ${name}();`,
    );
    try {
      await expect(prepare(account)).rejects.toThrow('PAPER_PREPARATION_STORAGE_FAILED');
      await expect(db.paperPreparation.read(account)).rejects.toThrow('PAPER_ACCOUNT_NOT_FOUND');
    } finally {
      await db.db.$client.query(`DROP TRIGGER ${name} ON paper_events; DROP FUNCTION ${name}();`);
    }
  });
});
