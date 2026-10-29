import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from '@hth/database';
import { migrateTestDatabase, testDatabaseUrl } from '@hth/database/testing';
import { paperDashboardStateSchema } from '@hth/contracts';
import { accountFixture } from '../../../packages/database/test/paper-fixtures.js';
import { createPaperDashboard } from './paper-dashboard.js';
import { createAuthenticatedTestApp } from '../test/app.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('Paper API 출처와 편집 경계', () => {
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
    instrument: { market: 'US', symbol: 'AAPL' },
    parameters: { fastPeriod: 5, slowPeriod: 20 },
    quantity: '1',
    maxFillQuantity: '1',
  } as const;
  it('인증된 market API는 DB 출처를 표시하며 US 편집은 실행을 정지한 채 저장한다', async () => {
    const { id } = await accountFixture(database, '15000', [], 'toss-readonly');
    const service = createPaperDashboard(database, id, 'toss-readonly');
    const app = createAuthenticatedTestApp('silent', undefined, undefined, undefined, {
      ...service,
      close: async () => {},
    });
    try {
      const response = await app.inject({ method: 'GET', url: '/v1/paper', headers: { host: 'localhost:4000' } });
      expect(response.statusCode).toBe(200);
      const data = paperDashboardStateSchema.parse(response.json());
      expect(data.source).toBe('toss-readonly');
      expect(paperDashboardStateSchema.safeParse({ ...data, source: 'synthetic-only' }).success).toBe(false);
      expect(response.body).not.toContain(id);
      await service.updateStrategy('ma-a', { expectedRevision: 1, enabled: true, definition });
      expect((await database.paper.readAccount(id)).control.stopped).toBe(true);
      const invalid = { ...definition, parameters: { fastPeriod: 5, slowPeriod: 200 } };
      await expect(
        service.updateStrategy('ma-a', { expectedRevision: 2, enabled: true, definition: invalid }),
      ).rejects.toThrow('PAPER_STRATEGY_SOURCE_UNSUPPORTED');
    } finally {
      await app.close();
    }
  });
  it('합성 source의 US 편집과 서버 설정/DB 출처 불일치를 거부한다', async () => {
    const { id } = await accountFixture(database);
    const service = createPaperDashboard(database, id);
    await expect(service.updateStrategy('ma-a', { expectedRevision: 1, enabled: true, definition })).rejects.toThrow(
      'PAPER_STRATEGY_SOURCE_UNSUPPORTED',
    );
    await expect(createPaperDashboard(database, id, 'toss-readonly').read()).rejects.toThrow('PAPER_SOURCE_MISMATCH');
  });
  it('미확인 계좌는 조회/정지만 허용하고 출처를 추정하거나 편집하지 않는다', async () => {
    const { id } = await accountFixture(database, '15000', [], 'unverified');
    const service = createPaperDashboard(database, id);
    expect((await service.read()).source).toBe('unverified');
    await expect(service.updateStrategy('ma-a', { expectedRevision: 1, enabled: true, definition })).rejects.toThrow(
      'PAPER_SOURCE_MISMATCH',
    );
    await service.stop();
    expect((await database.paper.readAccount(id)).control.stopped).toBe(true);
  });
});
