import { processHealthSchema } from '@hth/contracts';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { parseApiConfig } from './config.js';

describe('API foundation', () => {
  it('키가 존재해도 live 설정은 거부한다', () => {
    expect(() => parseApiConfig({ TRADING_MODE: 'live', TOSS_CLIENT_SECRET: 'test-only' })).toThrow();
    expect(parseApiConfig({ TOSS_CLIENT_SECRET: 'test-only' }).TRADING_MODE).toBe('paper');
    expect(() => parseApiConfig({ API_PORT: 'invalid' })).toThrow();
  });

  it('생존 확인만 제공하고 주문 경로는 제공하지 않는다', async () => {
    const app = createApp();
    try {
      const health = await app.inject({ method: 'GET', url: '/health/live' });
      expect(health.statusCode).toBe(200);
      expect(processHealthSchema.parse(health.json()).executionEnabled).toBe(false);
      const order = await app.inject({ method: 'POST', url: '/v1/orders', payload: {} });
      expect(order.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
