import { describe, expect, it, vi } from 'vitest';
import type { PaperDashboardState } from '@hth/contracts';
import { createAuthenticatedTestApp as createApp, testOwnerHash } from '../test/app.js';
import { parseApiConfig } from './config.js';
import type { PaperDashboard } from './paper-dashboard.js';

const disabled: PaperDashboardState = {
  status: 'disabled',
  mode: 'paper',
  source: 'unverified',
  executionEnabled: false,
  snapshot: null,
};
function fixture() {
  const service: PaperDashboard = {
    read: vi.fn(async () => disabled),
    stop: vi.fn(async () => {}),
    updateStrategy: vi.fn(async () => {
      throw new Error('UNUSED_TEST_UPDATE');
    }),
    close: vi.fn(async () => {}),
  };
  return { service, app: createApp('silent', undefined, undefined, undefined, service) };
}
const headers = { host: 'localhost:4000', 'x-hth-dashboard': '1' };
describe('Paper 대시보드 접근·정지 경계', () => {
  it('market 연결은 전용 DB와 market 계좌를 명시해야 하고 기본 dev 연결을 바꾸지 않는다', () => {
    const market = {
      PAPER_DASHBOARD_ENABLED: 'true',
      OWNER_PASSWORD_HASH: testOwnerHash,
      PAPER_DASHBOARD_KIND: 'market',
      PAPER_MARKET_DATABASE_URL: 'postgresql://hth_test:x@127.0.0.1:55434/hth_readonly_test',
      PAPER_MARKET_ACCOUNT_ID: 'paper-market-local',
    };
    expect(parseApiConfig(market).PAPER_DASHBOARD_KIND).toBe('market');
    expect(parseApiConfig({}).PAPER_DASHBOARD_KIND).toBe('synthetic');
    for (const override of [
      { PAPER_MARKET_ACCOUNT_ID: 'paper-demo-local' },
      { PAPER_MARKET_DATABASE_URL: undefined },
      { PAPER_MARKET_DATABASE_URL: 'postgresql://hth:x@localhost/hth_trading' },
      { PAPER_MARKET_DATABASE_URL: `${market.PAPER_MARKET_DATABASE_URL}?options=unsafe` },
      { API_HOST: '0.0.0.0' },
    ])
      expect(() => parseApiConfig({ ...market, ...override })).toThrow();
  });
  it('기본 비활성이고 조회가 실행이나 계좌 생성을 시작하지 않는다', async () => {
    const app = createApp();
    try {
      expect((await app.inject({ method: 'GET', url: '/v1/paper', headers })).json()).toEqual(disabled);
      expect((await app.inject({ method: 'POST', url: '/v1/paper/stop', headers, payload: {} })).statusCode).toBe(503);
      for (const path of ['/v1/paper/resume', '/v1/paper/start', '/v1/paper/orders'])
        expect((await app.inject({ method: 'POST', url: path, headers, payload: {} })).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
  it('공개 bind·production·사용자 DB·계좌 미지정을 활성화 설정에서 거부한다', () => {
    const valid = {
      PAPER_DASHBOARD_ENABLED: 'true',
      OWNER_PASSWORD_HASH: testOwnerHash,
      PAPER_DEMO_DATABASE_URL: 'postgresql://hth_test:x@127.0.0.1:55433/hth_readonly_test',
      PAPER_DEMO_ACCOUNT_ID: 'paper-demo-local',
    };
    expect(parseApiConfig(valid).PAPER_DASHBOARD_ENABLED).toBe(true);
    for (const override of [
      { API_HOST: '0.0.0.0' },
      { NODE_ENV: 'production' },
      { PAPER_DEMO_DATABASE_URL: 'postgresql://hth:x@localhost/hth_trading' },
      { PAPER_DEMO_DATABASE_URL: 'postgresql://hth_test:x@remote.invalid/hth_readonly_test' },
      { PAPER_DEMO_ACCOUNT_ID: '' },
      { PAPER_DEMO_ACCOUNT_ID: 'real-account' },
    ])
      expect(() => parseApiConfig({ ...valid, ...override })).toThrow();
    expect(() => parseApiConfig({ PAPER_DASHBOARD_ENABLED: 'true' })).toThrow();
  });
  it('외부 origin·host·IP·cross-site와 헤더 없는 정지는 서비스 호출 전에 차단한다', async () => {
    const { app, service } = fixture();
    try {
      for (const request of [
        { headers: { host: 'evil.invalid' } },
        { headers: { ...headers, origin: 'https://evil.invalid' } },
        { headers, remoteAddress: '192.0.2.1' },
        { headers: { ...headers, 'sec-fetch-site': 'cross-site' } },
        { headers: { host: 'localhost:4000' } },
      ])
        expect((await app.inject({ method: 'POST', url: '/v1/paper/stop', payload: {}, ...request })).statusCode).toBe(
          403,
        );
      expect(service.stop).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it('브라우저가 계좌·한도·재개·정지 사유를 주입할 수 없다', async () => {
    const { app, service } = fixture();
    try {
      expect((await app.inject({ method: 'GET', url: '/v1/paper?accountId=other', headers })).statusCode).toBe(400);
      for (const payload of [{ accountId: 'other' }, { stopped: false }, { reason: 'private' }, { mode: 'live' }])
        expect((await app.inject({ method: 'POST', url: '/v1/paper/stop', headers, payload })).statusCode).toBe(400);
      expect(
        (await app.inject({ method: 'POST', url: '/v1/paper/stop?accountId=other', headers, payload: {} })).statusCode,
      ).toBe(400);
      expect(service.stop).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it('정지는 커밋 확인만 반환하고 자동 재개·정리 완료를 주장하지 않는다', async () => {
    const { app, service } = fixture();
    const response = await app.inject({ method: 'POST', url: '/v1/paper/stop', headers, payload: {} });
    expect(response.json()).toEqual({ mode: 'paper', executionEnabled: false, stopped: true });
    expect(response.headers['cache-control']).toBe('no-store, private');
    expect(service.stop).toHaveBeenCalledTimes(1);
    expect(service.read).not.toHaveBeenCalled();
    await app.close();
    expect(service.close).toHaveBeenCalledOnce();
  });
  it('전략 변경은 고정 계좌의 리비전 검증 요청으로만 전달한다', async () => {
    const { app, service } = fixture();
    const definition = {
      kind: 'moving-average-cross',
      instrument: { market: 'KR', symbol: '005930' },
      parameters: { fastPeriod: 1, slowPeriod: 2 },
      quantity: '2',
      maxFillQuantity: '1',
    };
    const input = { expectedRevision: 1, definition, enabled: true };
    vi.mocked(service.updateStrategy).mockResolvedValueOnce({
      mode: 'paper',
      executionEnabled: false,
      stopped: true,
      strategy: { id: 'demo-ma', version: '1.0.0', revision: 2, definition, enabled: true },
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/paper/strategies/demo-ma',
        headers,
        payload: input,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ stopped: true, strategy: { revision: 2 } });
      expect(service.updateStrategy).toHaveBeenCalledWith('demo-ma', input);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/paper/strategies/demo-ma',
            headers,
            payload: { ...input, accountId: 'other' },
          })
        ).statusCode,
      ).toBe(400);
    } finally {
      await app.close();
    }
  });
  it('전략 리비전 충돌은 409로 반환하고 원본 예외를 숨긴다', async () => {
    const { app, service } = fixture();
    const input = {
      expectedRevision: 1,
      enabled: false,
      definition: {
        kind: 'moving-average-cross',
        instrument: { market: 'KR', symbol: '005930' },
        parameters: { fastPeriod: 1, slowPeriod: 2 },
        quantity: '2',
        maxFillQuantity: '1',
      },
    };
    try {
      vi.mocked(service.updateStrategy).mockRejectedValueOnce(new Error('PAPER_STRATEGY_REVISION_CONFLICT'));
      expect(
        (await app.inject({ method: 'POST', url: '/v1/paper/strategies/demo-ma', headers, payload: input })).statusCode,
      ).toBe(409);
      vi.mocked(service.updateStrategy).mockRejectedValueOnce(new Error('private-sql-data'));
      const failed = await app.inject({ method: 'POST', url: '/v1/paper/strategies/demo-ma', headers, payload: input });
      expect(failed.statusCode).toBe(503);
      expect(failed.body).not.toContain('private-sql-data');
      vi.mocked(service.updateStrategy).mockRejectedValueOnce(new Error('PAPER_STRATEGY_SOURCE_UNSUPPORTED'));
      const unsupported = await app.inject({
        method: 'POST',
        url: '/v1/paper/strategies/demo-ma',
        headers,
        payload: input,
      });
      expect(unsupported.statusCode).toBe(422);
      expect(unsupported.json()).toEqual({ error: { code: 'PAPER_STRATEGY_SOURCE_UNSUPPORTED' } });
    } finally {
      await app.close();
    }
  });
  it('전략 주기·정수 수량·최대 체결 수량을 입력 경계에서 검사한다', async () => {
    const { app, service } = fixture();
    try {
      for (const definition of [
        {
          kind: 'moving-average-cross',
          instrument: { market: 'KR', symbol: '005930' },
          parameters: { fastPeriod: 2, slowPeriod: 2 },
          quantity: '2',
          maxFillQuantity: '1',
        },
        {
          kind: 'moving-average-cross',
          instrument: { market: 'KR', symbol: '005930' },
          parameters: { fastPeriod: 1, slowPeriod: 2 },
          quantity: '2',
          maxFillQuantity: '3',
        },
      ])
        expect(
          (
            await app.inject({
              method: 'POST',
              url: '/v1/paper/strategies/demo-ma',
              headers,
              payload: { expectedRevision: 1, enabled: true, definition },
            })
          ).statusCode,
        ).toBe(400);
      expect(service.updateStrategy).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it('조회·정지 실패와 잘못된 DTO에서 원본 정보가 노출되지 않는다', async () => {
    const { app, service } = fixture();
    const secret = 'private-account-token';
    try {
      vi.mocked(service.read).mockRejectedValueOnce(new Error(secret));
      const read = await app.inject({ method: 'GET', url: '/v1/paper', headers });
      expect(read.statusCode).toBe(503);
      expect(read.body).not.toContain(secret);
      vi.mocked(service.stop).mockRejectedValueOnce(new Error(secret));
      const stop = await app.inject({ method: 'POST', url: '/v1/paper/stop', headers, payload: {} });
      expect(stop.json()).toEqual({ error: { code: 'PAPER_STOP_UNCONFIRMED' } });
      vi.mocked(service.read).mockResolvedValueOnce({ ...disabled, accountId: secret } as PaperDashboardState);
      const invalid = await app.inject({ method: 'GET', url: '/v1/paper', headers });
      expect(invalid.statusCode).toBe(503);
      expect(invalid.body).not.toContain(secret);
    } finally {
      await app.close();
    }
  });
});
