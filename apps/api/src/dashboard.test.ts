import { describe, expect, it, vi } from 'vitest';
import type { DashboardSnapshot } from '@hth/contracts';
import { createAuthenticatedTestApp as createApp, testOwnerHash } from '../test/app.js';
import { parseApiConfig } from './config.js';
import { createDashboardService } from './dashboard-service.js';

const snapshot: DashboardSnapshot = {
  collectedAt: '2026-10-28T00:00:00Z',
  accountCount: 0,
  portfolios: [
    { currency: 'KRW', value: '0', cost: '0', pnl: '0', buyingPower: '0' },
    { currency: 'USD', value: '0', cost: '0', pnl: '0', buyingPower: '0' },
  ],
  holdings: [],
  watchlist: [],
  markets: [],
  exchangeRate: {
    rate: '1400',
    midRate: '1390',
    validFrom: '2026-10-28T00:00:00Z',
    validUntil: '2026-10-28T00:01:00Z',
  },
};

describe('대시보드 API 접근 경계', () => {
  it('공개 bind 및 production에서 대시보드 활성화를 거부한다', () => {
    expect(() => parseApiConfig({ DASHBOARD_ENABLED: 'true', API_HOST: '0.0.0.0' })).toThrow();
    expect(() => parseApiConfig({ DASHBOARD_ENABLED: 'true', NODE_ENV: 'production' })).toThrow();
    expect(parseApiConfig({ DASHBOARD_ENABLED: 'true', OWNER_PASSWORD_HASH: testOwnerHash }).DASHBOARD_ENABLED).toBe(
      true,
    );
  });

  it('외부 origin·host·IP와 CSRF성 새로고침을 차단한다', async () => {
    const service = createDashboardService({ enabled: true, configured: true, load: vi.fn(async () => snapshot) });
    const app = createApp('silent', service);
    try {
      for (const request of [
        { headers: { host: 'localhost:4000', origin: 'https://attacker.invalid' } },
        { headers: { host: 'attacker.invalid:4000' } },
        { headers: { host: 'localhost:4000' }, remoteAddress: '192.0.2.1' },
        { headers: { host: 'localhost:4000', 'sec-fetch-site': 'cross-site' } },
      ])
        expect((await app.inject({ method: 'GET', url: '/v1/dashboard', ...request })).statusCode).toBe(403);
      const blocked = await app.inject({
        method: 'POST',
        url: '/v1/dashboard/refresh',
        headers: { host: 'localhost:4000' },
        payload: {},
      });
      expect(blocked.statusCode).toBe(403);
      const response = await app.inject({ method: 'GET', url: '/v1/dashboard', headers: { host: 'localhost:4000' } });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store, private');
      expect((await app.inject({ method: 'POST', url: '/v1/orders', payload: {} })).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('새로고침은 단일 작업으로 실행하고 30초 동안 중복 실행하지 않는다', async () => {
    let clock = 0;
    const load = vi.fn(async () => snapshot);
    const service = createDashboardService({ enabled: true, configured: true, load, now: () => clock });
    service.refresh();
    service.refresh();
    expect(load).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(service.read().refreshing).toBe(false));
    expect(service.read().snapshot).toEqual(snapshot);
    expect(service.read().canRefresh).toBe(false);
    clock = 30_001;
    service.refresh();
    await vi.waitFor(() => expect(service.read().refreshing).toBe(false));
    expect(load).toHaveBeenCalledTimes(2);
    service.close();
  });

  it('재조회 실패 시 마지막 정상 데이터는 유지하고 원본 오류는 반환하지 않는다', async () => {
    let clock = 0;
    const load = vi.fn(async () => snapshot);
    const service = createDashboardService({ enabled: true, configured: true, load, now: () => clock });
    service.refresh();
    await vi.waitFor(() => expect(service.read().refreshing).toBe(false));
    clock = 30_001;
    load.mockRejectedValueOnce(new Error('private-token accountNo=secret'));
    service.refresh();
    await vi.waitFor(() => expect(service.read().refreshing).toBe(false));
    expect(service.read()).toMatchObject({ connection: 'error', error: 'WORKER_ERROR', snapshot });
    expect(JSON.stringify(service.read())).not.toContain('private-token');
    service.close();
  });

  it('키가 없거나 비활성 상태에서는 worker를 실행하지 않는다', () => {
    const load = vi.fn(async () => snapshot);
    for (const options of [
      { enabled: false, configured: true },
      { enabled: true, configured: false },
    ]) {
      const service = createDashboardService({ ...options, load });
      service.refresh();
      expect(service.read().canRefresh).toBe(false);
    }
    expect(load).not.toHaveBeenCalled();
  });
  it('설정 변경은 캐시/진행 중 조회를 무효화하고 늦은 응답을 폐기한다', async () => {
    let complete!: (value: typeof snapshot) => void;
    const load = vi.fn(
      () =>
        new Promise<typeof snapshot>((resolve) => {
          complete = resolve;
        }),
    );
    const service = createDashboardService({ enabled: true, configured: true, load });
    service.refresh();
    service.invalidate();
    expect(load.mock.calls).toHaveLength(1);
    expect(service.read().snapshot).toBeNull();
    complete(snapshot);
    await Promise.resolve();
    await Promise.resolve();
    expect(service.read().snapshot).toBeNull();
    expect(service.read().refreshing).toBe(false);
    expect(service.read().canRefresh).toBe(false);
    service.close();
  });
});
