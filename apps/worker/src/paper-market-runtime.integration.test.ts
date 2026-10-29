import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from '@hth/database';
import { migrateTestDatabase, testDatabaseUrl } from '@hth/database/testing';
import { createHarness } from '../../../packages/broker/test/harness.js';
import { parsePaperMarketConfig } from './paper-market-config.js';
import { runPaperMarket } from './paper-market-runtime.js';
import type { PaperMarketDependencies } from './paper-market-runtime.js';
import { createPaperWorker } from './paper-worker.js';
import { paperSyntheticSource } from './paper-synthetic-source.js';
import type { PaperEvidence } from '@hth/contracts';

describe.skipIf(!process.env.TEST_DATABASE_URL)('실제 시세 Paper 명령의 DB 검증 (fixture broker)', () => {
  let database: ReturnType<typeof createDatabase>;
  beforeAll(async () => {
    database = createDatabase(testDatabaseUrl());
    await migrateTestDatabase(database);
  }, 30000);
  afterAll(async () => {
    await database?.close();
  });
  function fixture() {
    const id = `paper-market-${randomUUID()}`;
    const config = (flags: string[]) =>
      parsePaperMarketConfig([`--account=${id}`, ...flags], {
        TOSS_CLIENT_ID: `fixture-${id}`,
        TOSS_CLIENT_SECRET: 'fixture-secret',
        DATABASE_URL: 'postgresql://hth:unused@localhost:5432/hth_trading',
        PAPER_MARKET_DATABASE_URL: testDatabaseUrl(),
      });
    let brokerCreated = 0;
    const dependencies: PaperMarketDependencies = {
      paper: database.paper,
      prepare: () => migrateTestDatabase(database),
      withBrokerLease: (key, operation) => database.withBrokerLease(key, operation),
      createBroker: () => {
        brokerCreated++;
        const { broker } = createHarness();
        // The static fixture contains two symbols; project to requested set.
        return {
          ...broker,
          getMarketCalendar: async () =>
            (
              (await paperSyntheticSource(
                [{ market: 'KR', symbol: '005930' }],
                new AbortController().signal,
              )) as PaperEvidence[]
            )[0]!.marketData.calendar!,
          getInstruments: async (requested) =>
            (
              await broker.getInstruments([
                { market: 'KR', symbol: '005930' },
                { market: 'US', symbol: 'AAPL' },
              ])
            ).filter((item) => requested.some((id) => id.market === item.id.market && id.symbol === item.id.symbol)),
          getQuotes: async (requested) =>
            (
              await broker.getQuotes([
                { market: 'KR', symbol: '005930' },
                { market: 'US', symbol: 'AAPL' },
              ])
            ).filter((item) =>
              requested.some((id) => id.market === item.instrument.market && id.symbol === item.instrument.symbol),
            ),
        };
      },
      createWorker: (value, source) => createPaperWorker(database.paper, value, source),
    };
    const run = (flags: string[] = []) =>
      runPaperMarket(config(flags), dependencies, new AbortController().signal, () => {});
    return { id, run, dependencies, brokerCreated: () => brokerCreated };
  }
  it('기본 관측은 정지 상태이며 기존 계좌 재초기화로 현금/조건을 바꾸지 않는다', async () => {
    const context = fixture();
    await context.run(['--initialize']);
    const before = await database.paper.readAccount(context.id);
    expect(before.control.stopped).toBe(true);
    expect(before.leaseUntil).toBeNull();
    expect((await database.paper.readDashboard(context.id)).orders).toHaveLength(0);
    await expect(context.run(['--initialize'])).rejects.toThrow('PAPER_MARKET_ACCOUNT_EXISTS');
    expect((await database.paper.readAccount(context.id)).snapshot.cash).toEqual(before.snapshot.cash);
    expect(context.brokerCreated()).toBe(1);
  });
  it('오래된 시세로 resume하면 의도/체결 없이 중단하고 lease를 해제한다', async () => {
    const context = fixture();
    await context.run(['--initialize']);
    await expect(context.run(['--resume'])).rejects.toThrow('PAPER_WORKER_DATA_NOT_READY');
    const account = await database.paper.readAccount(context.id);
    expect(account.control.stopped).toBe(true);
    expect(account.leaseUntil).toBeNull();
    const dashboard = await database.paper.readDashboard(context.id);
    expect(dashboard.orders).toHaveLength(0);
    expect(dashboard.fills).toHaveLength(0);
  });
  it('긴급 정지는 별도 broker 생성 없이 영속 정지 epoch를 올린다', async () => {
    const context = fixture();
    await context.run(['--initialize']);
    const before = await database.paper.readAccount(context.id);
    await context.run(['--stop']);
    const after = await database.paper.readAccount(context.id);
    expect(after.control.stopped).toBe(true);
    expect(after.control.epoch).toBeGreaterThan(before.control.epoch);
    expect(context.brokerCreated()).toBe(1);
    expect(after.snapshot.cash).toEqual(before.snapshot.cash);
  });
});
