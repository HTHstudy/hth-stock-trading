import { describe, expect, it, vi } from 'vitest';
import type { PaperDashboardState } from '@hth/contracts';
import { createApp } from './app.js';
import { parseApiConfig } from './config.js';
import type { PaperDashboard } from './paper-dashboard.js';

const disabled: PaperDashboardState = {
  status: 'disabled',
  mode: 'paper',
  source: 'synthetic-only',
  executionEnabled: false,
  snapshot: null,
};
function fixture() {
  const service: PaperDashboard = {
    read: vi.fn(async () => disabled),
    stop: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  return { service, app: createApp('silent', undefined, undefined, undefined, service) };
}
const headers = { host: 'localhost:4000', 'x-hth-dashboard': '1' };
describe('Paper 대시보드 접근·정지 경계', () => {
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
