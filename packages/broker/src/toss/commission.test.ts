import { describe, expect, it, vi } from 'vitest';
import type { BrokerAccount, BrokerCommissionLookup, ReadonlyBroker } from '../index.js';
import { createTossReadonlyBroker } from './index.js';
import type { TossFetch } from './index.js';

const account: BrokerAccount = { reference: '123456789', type: 'BROKERAGE' };
const token = 'fake-commission-access-token';
const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });

// Exact public 200 examples from the downloaded 2026-11-06 official OpenAPI.
const examples = {
  standard: {
    result: [
      { marketCountry: 'KR', commissionRate: '0.00015', startDate: '2026-01-01', endDate: '2026-12-31' },
      { marketCountry: 'US', commissionRate: '0.001', startDate: null, endDate: '2026-06-30' },
    ],
  },
  unlimited: {
    result: [
      { marketCountry: 'KR', commissionRate: '0.00015', startDate: '2026-01-01', endDate: null },
      { marketCountry: 'US', commissionRate: '0.0025', startDate: null, endDate: null },
    ],
  },
};

function harness(payload: unknown = examples.standard) {
  let time = Date.parse('2026-11-06T00:00:00Z');
  const wait = vi.fn(async (milliseconds: number) => {
    time += milliseconds;
  });
  const respond = vi.fn(async () => json(payload));
  const fetcher = vi.fn<TossFetch>(async (url, init) => {
    const path = new URL(url).pathname;
    if (path === '/oauth2/token' && init.method === 'POST')
      return json({ access_token: token, token_type: 'Bearer', expires_in: 3600 });
    if (path === '/api/v1/commissions' && init.method === 'GET') return respond();
    if (path === '/api/v1/buying-power' && init.method === 'GET')
      return json({ result: { currency: 'KRW', cashBuyingPower: '100' } });
    throw new Error('Unexpected fake route');
  });
  const broker = createTossReadonlyBroker({
    clientId: 'fake-client',
    clientSecret: 'fake-secret',
    fetch: fetcher,
    now: () => time,
    wait,
    random: () => 0,
  });
  return { broker, fetcher, respond, wait };
}

describe('Toss read-only commission capability', () => {
  it.each(Object.entries(examples))(
    'normalizes the official %s example without converting rates',
    async (_, example) => {
      const { broker, fetcher } = harness(example);
      const capability: BrokerCommissionLookup = broker;
      const result = await capability.getCommissionRates(account);
      expect(result).toEqual(
        example.result.map((row) => ({
          market: row.marketCountry,
          rate: row.commissionRate,
          startsOn: row.startDate,
          endsOn: row.endDate,
          periodBoundsKnown: true,
        })),
      );
      const calls = fetcher.mock.calls;
      expect(calls).toHaveLength(2);
      expect(calls[0]![0]).toBe('https://openapi.tossinvest.com/oauth2/token');
      const [url, init] = calls[1]!;
      expect(url).toBe('https://openapi.tossinvest.com/api/v1/commissions');
      expect(init.method).toBe('GET');
      expect(init.body).toBeUndefined();
      expect(new Headers(init.headers).get('X-Tossinvest-Account')).toBe(account.reference);
      expect(new Headers(init.headers).get('Authorization')).toBe(`Bearer ${token}`);
      expect(init.redirect).toBe('error');
    },
  );

  it('keeps commission lookup optional for the existing read-only broker contract', () => {
    // A pre-existing broker implementation must not need the new capability.
    const broker: ReadonlyBroker = {
      id: 'fake',
      listAccounts: async () => [],
      getHoldings: async () => [],
      getBuyingPower: async () => ({ currency: 'KRW', amount: '0' }),
      getInstruments: async () => [],
      getQuotes: async () => [],
      getCandles: async () => ({ candles: [], nextBefore: null }),
      getExchangeRate: async () => ({
        baseCurrency: 'USD',
        quoteCurrency: 'KRW',
        rate: '1',
        midRate: '1',
        validFrom: '2026-01-01T00:00:00Z',
        validUntil: '2026-01-02T00:00:00Z',
      }),
      getMarketCalendar: async () => {
        throw new Error('Unused fake calendar');
      },
    };
    expect(broker).not.toHaveProperty('getCommissionRates');
  });

  it.each([
    [{}, null, null, false],
    [{ startDate: null }, null, null, false],
    [{ endDate: null }, null, null, false],
    [{ startDate: '2026-01-01' }, '2026-01-01', null, false],
    [{ endDate: '2026-12-31' }, null, '2026-12-31', false],
    [{ startDate: null, endDate: null }, null, null, true],
    [{ startDate: '2026-01-01', endDate: null }, '2026-01-01', null, true],
    [{ startDate: null, endDate: '2026-12-31' }, null, '2026-12-31', true],
  ])('distinguishes supplied null bounds from missing bounds: %j', async (bounds, startsOn, endsOn, known) => {
    const { broker } = harness({ result: [{ marketCountry: 'KR', commissionRate: '0', ...bounds }] });
    expect(await broker.getCommissionRates(account)).toEqual([
      { market: 'KR', rate: '0', startsOn, endsOn, periodBoundsKnown: known },
    ]);
  });

  it.each(['0', '0.0000000000000000000000000001', '0.9999999999999999999999999999', '000.00015'])(
    'preserves exact valid decimal strings: %s',
    async (rate) => {
      const { broker } = harness({ result: [{ marketCountry: 'US', commissionRate: rate }] });
      expect((await broker.getCommissionRates(account))[0]?.rate).toBe(rate);
    },
  );

  it.each([
    { commissionRate: '-0.00015' },
    { commissionRate: '-0' },
    { commissionRate: '1' },
    { commissionRate: '1.0000' },
    { commissionRate: '0001.0' },
    { commissionRate: '1.0000000000000000000000000001' },
    { commissionRate: '2' },
    { commissionRate: '0.' + '0'.repeat(28) + '1' },
    { commissionRate: 0.00015 },
    { commissionRate: null },
    { commissionRate: '1e-4' },
    { commissionRate: 'NaN' },
    { commissionRate: '' },
    { commissionRate: ' 0.1' },
    { marketCountry: 'JP' },
    { marketCountry: 'kr' },
    { startDate: '2026-02-29' },
    { endDate: '2026-04-31' },
    { startDate: '2026-1-01' },
    { startDate: '2026-01-01T00:00:00Z' },
    { endDate: 20260101 },
    { startDate: '2026-12-31', endDate: '2026-01-01' },
  ])('rejects invalid commission rows: %j', async (fields) => {
    const { broker } = harness({ result: [{ marketCountry: 'KR', commissionRate: '0.00015', ...fields }] });
    await expect(broker.getCommissionRates(account)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it.each([{}, { result: null }, { result: {} }, { result: [{}] }, { result: [{ marketCountry: 'KR' }] }])(
    'rejects malformed response envelopes: %j',
    async (payload) => {
      const { broker } = harness(payload);
      await expect(broker.getCommissionRates(account)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    },
  );

  it('accepts an empty array without inventing rates', async () => {
    const { broker } = harness({ result: [] });
    expect(await broker.getCommissionRates(account)).toEqual([]);
  });

  it('preserves duplicates, overlaps, original order, and equal date bounds for downstream review', async () => {
    const row = examples.standard.result[0]!;
    const rows = [
      row,
      { ...row, commissionRate: '0.0002' },
      row,
      { ...row, startDate: '2026-06-01', endDate: '2026-06-01' },
    ];
    const { broker } = harness({ result: rows });
    expect(await broker.getCommissionRates(account)).toEqual(
      rows.map((item) => ({
        market: item.marketCountry,
        rate: item.commissionRate,
        startsOn: item.startDate,
        endsOn: item.endDate,
        periodBoundsKnown: true,
      })),
    );
  });

  it.each(['', '-1', '1.0', 'abc', '12345678901234567', '1\r\nInjected: x'])(
    'rejects invalid account reference before issuing a token: %j',
    async (reference) => {
      const { broker, fetcher } = harness();
      await expect(broker.getCommissionRates({ ...account, reference })).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it('projects only commission fields and excludes account and token information', async () => {
    const { broker } = harness({
      access_token: token,
      accountSeq: account.reference,
      result: [{ ...examples.standard.result[0], accountNo: account.reference, access_token: token }],
    });
    const result = await broker.getCommissionRates(account);
    expect(Object.keys(result[0]!).sort()).toEqual(['endsOn', 'market', 'periodBoundsKnown', 'rate', 'startsOn']);
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain(account.reference);
  });

  it('shares token reuse and the ORDER_INFO limiter with buying-power lookup', async () => {
    const { broker, fetcher, wait } = harness();
    await broker.getBuyingPower(account, 'KRW');
    await broker.getCommissionRates(account);
    await broker.getCommissionRates(account);
    expect(fetcher.mock.calls.filter(([url]) => new URL(url).pathname === '/oauth2/token')).toHaveLength(1);
    expect(wait.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([334, 334]);
    expect(
      fetcher.mock.calls.every(([url, init]) => new URL(url).pathname === '/oauth2/token' || init.method === 'GET'),
    ).toBe(true);
  });

  it.each([
    [400, 'UPSTREAM_REJECTED', 1],
    [403, 'PERMISSION_DENIED', 1],
    [429, 'RATE_LIMITED', 3],
    [500, 'UPSTREAM_UNAVAILABLE', 3],
    [401, 'AUTHENTICATION_FAILED', 2],
  ] as const)(
    'propagates sanitized HTTP %s failures through the existing transport',
    async (status, code, attempts) => {
      const { broker, respond } = harness();
      respond.mockImplementation(async () => json({ error: { message: `${token} ${account.reference}` } }, status));
      const error: unknown = await broker.getCommissionRates(account).catch((failure: unknown) => failure);
      expect(error).toMatchObject({ code, status, message: code });
      expect(String(error)).not.toContain(token);
      expect(JSON.stringify(error)).not.toContain(account.reference);
      expect(respond).toHaveBeenCalledTimes(attempts);
    },
  );

  it('propagates token failures without making a commission request', async () => {
    const { broker, fetcher, respond } = harness();
    fetcher.mockImplementationOnce(async () => json({ error: 'access_denied' }, 403));
    await expect(broker.getCommissionRates(account)).rejects.toMatchObject({ code: 'PERMISSION_DENIED', status: 403 });
    expect(respond).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('propagates sanitized network failure after the existing bounded retries', async () => {
    const { broker, respond } = harness();
    respond.mockImplementation(async () => {
      throw new Error(`${token} ${account.reference}`);
    });
    await expect(broker.getCommissionRates(account)).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
      message: 'NETWORK_ERROR',
    });
    expect(respond).toHaveBeenCalledTimes(3);
  });
});
