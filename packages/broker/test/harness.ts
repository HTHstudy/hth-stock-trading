import { vi } from 'vitest';
import { createTossReadonlyBroker } from '../src/toss/index.js';
import type { TossFetch } from '../src/toss/index.js';
import fixtures from './fixtures.json' with { type: 'json' };

export { fixtures };

export function jsonResponse(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

export function createHarness(handler?: TossFetch) {
  let currentTime = Date.parse('2026-03-25T00:33:00Z');
  const waits: number[] = [];
  const fetcher = vi.fn<TossFetch>(
    handler ??
      (async (url, init) => {
        const endpoint = new URL(url);
        if (endpoint.pathname === '/oauth2/token')
          return jsonResponse({ access_token: 'fixture-token', token_type: 'Bearer', expires_in: 3600 });
        const routes: Record<string, unknown> = {
          '/api/v1/accounts': fixtures.accounts,
          '/api/v1/holdings': fixtures.holdings,
          '/api/v1/stocks': fixtures.stocks,
          '/api/v1/prices': fixtures.quotes,
          '/api/v1/candles': {
            result: {
              ...fixtures.candles.result,
              candles: fixtures.candles.result.candles.map((candle) => ({
                ...candle,
                currency: endpoint.searchParams.get('symbol') === 'AAPL' ? 'USD' : 'KRW',
              })),
            },
          },
          '/api/v1/buying-power': {
            result: { currency: endpoint.searchParams.get('currency'), cashBuyingPower: '5000000' },
          },
          '/api/v1/exchange-rate': fixtures.exchangeRate,
          '/api/v1/market-calendar/KR': fixtures.krCalendar,
          '/api/v1/market-calendar/US': fixtures.usCalendar,
        };
        if (init.method !== 'GET' || !(endpoint.pathname in routes)) throw new Error('Unexpected fixture route');
        return jsonResponse(routes[endpoint.pathname]);
      }),
  );
  const broker = createTossReadonlyBroker({
    clientId: 'fixture-client',
    clientSecret: 'fixture-secret',
    fetch: fetcher,
    now: () => currentTime,
    wait: async (milliseconds) => {
      waits.push(milliseconds);
      currentTime += milliseconds;
    },
    random: () => 0,
  });
  return {
    broker,
    fetcher,
    waits,
    advance: (milliseconds: number) => {
      currentTime += milliseconds;
    },
  };
}
