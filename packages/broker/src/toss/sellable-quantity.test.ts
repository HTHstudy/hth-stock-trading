import { expect, it, vi } from 'vitest';
import type { InstrumentId } from '@hth/contracts';
import type { BrokerAccount, BrokerSellableQuantityLookup } from '../index.js';
import { createTossReadonlyBroker } from './index.js';
import type { TossFetch } from './transport.js';
const account = { reference: '42', type: 'BROKERAGE' };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
function harness(body: unknown = { result: { sellableQuantity: '100' } }) {
  let time = 0;
  const respond = vi.fn(async () => json(body)),
    wait = vi.fn(async (ms: number) => {
      time += ms;
    });
  const fetcher = vi.fn<TossFetch>(async (url, init) => {
    if (new URL(url).pathname === '/oauth2/token' && init.method === 'POST')
      return json({ access_token: 'fake-token', token_type: 'Bearer', expires_in: 3600 });
    if (new URL(url).pathname === '/api/v1/sellable-quantity' && init.method === 'GET') return respond();
    if (new URL(url).pathname === '/api/v1/buying-power' && init.method === 'GET')
      return json({ result: { currency: 'KRW', cashBuyingPower: '100' } });
    throw new Error('UNEXPECTED_FAKE_ROUTE');
  });
  return {
    broker: createTossReadonlyBroker({
      clientId: 'fake-client',
      clientSecret: 'fake-secret',
      fetch: fetcher,
      now: () => time,
      wait,
      random: () => 0,
    }),
    fetcher,
    respond,
    wait,
  };
}
it('공식 판매 가능 수량 예제는 계좌 헤더/정규화 심볼의 GET으로 조회한다', async () => {
  const { broker, fetcher } = harness();
  const lookup: BrokerSellableQuantityLookup = broker;
  expect(await lookup.getSellableQuantity(account, { market: 'KR', symbol: '005930' })).toEqual({
    instrument: { market: 'KR', symbol: '005930' },
    quantity: '100',
  });
  const [url, init] = fetcher.mock.calls[1]!;
  expect(url).toBe('https://openapi.tossinvest.com/api/v1/sellable-quantity?symbol=005930');
  expect(init.method).toBe('GET');
  expect(init.body).toBeUndefined();
  expect(init.redirect).toBe('error');
  expect(new Headers(init.headers).get('X-Tossinvest-Account')).toBe('42');
  expect(new Headers(init.headers).get('Authorization')).toBe('Bearer fake-token');
});
it.each(['0', '0.000001', '12345678901234567890.123456789'])(
  'US 수량 %s를 number 변환/반올림 없이 보존한다',
  async (quantity) => {
    const { broker } = harness({ result: { sellableQuantity: quantity, PRIVATE_FIELD: 'must-be-removed' } });
    expect(await broker.getSellableQuantity(account, { market: 'US', symbol: 'brk.b' })).toEqual({
      instrument: { market: 'US', symbol: 'BRK.B' },
      quantity,
    });
  },
);
it('영문이 포함된 국내 6자리 코드와 정수값 소수 표현을 보존한다', async () => {
  const { broker } = harness({ result: { sellableQuantity: '10.000' } });
  expect(await broker.getSellableQuantity(account, { market: 'KR', symbol: '0101n0' })).toEqual({
    instrument: { market: 'KR', symbol: '0101N0' },
    quantity: '10.000',
  });
});
it.each([null, undefined, 10, '-1', '-0', 'NaN', '1e3', '9'.repeat(31)])(
  '잘못된 수량 응답은 원문 없이 거부한다 %#',
  async (quantity) => {
    const { broker } = harness({ result: { sellableQuantity: quantity, account: 'PRIVATE_ACCOUNT' } });
    await expect(broker.getSellableQuantity(account, { market: 'US', symbol: 'AAPL' })).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
  },
);
it('국내 소수 수량은 지원하지 않으며 정수로 잘라 반환하지 않는다', async () => {
  const { broker } = harness({ result: { sellableQuantity: '1.01' } });
  await expect(broker.getSellableQuantity(account, { market: 'KR', symbol: '005930' })).rejects.toMatchObject({
    code: 'INVALID_RESPONSE',
  });
});
it.each([
  { market: 'KR', symbol: 'AAPL' },
  { market: 'US', symbol: 'AAPL/../../x' },
  { market: 'JP', symbol: '1234' },
  { market: 'US', symbol: 'a'.repeat(41) },
  { market: 'US', symbol: 'AAPL', canSell: true },
])('잘못된 종목 문맥은 토큰 발급 전에 차단한다 %#', async (instrument) => {
  const { broker, fetcher } = harness();
  await expect(broker.getSellableQuantity(account, instrument as InstrumentId)).rejects.toMatchObject({
    code: 'INVALID_INPUT',
  });
  expect(fetcher).not.toHaveBeenCalled();
});
it('잘못된 계좌도 인증 전에 거부한다', async () => {
  const { broker, fetcher } = harness();
  await expect(
    broker.getSellableQuantity({ reference: 'PRIVATE/ACCOUNT', type: 'BROKERAGE' } as BrokerAccount, {
      market: 'US',
      symbol: 'AAPL',
    }),
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(fetcher).not.toHaveBeenCalled();
});
it('기존 매수 가능 조회와 같은 token manager/ORDER_INFO 슬롯을 공유한다', async () => {
  const { broker, fetcher, wait } = harness();
  await broker.getBuyingPower(account, 'KRW');
  await broker.getSellableQuantity(account, { market: 'KR', symbol: '005930' });
  expect(fetcher.mock.calls.filter(([url]) => new URL(url).pathname === '/oauth2/token')).toHaveLength(1);
  expect(wait).toHaveBeenCalled();
  expect(
    fetcher.mock.calls
      .filter(([url]) => new URL(url).pathname.startsWith('/api/'))
      .every(([, init]) => init.method === 'GET'),
  ).toBe(true);
});
it('429와 GET 재시도는 기존 transport를 재사용하며 주문 전송으로 확장하지 않는다', async () => {
  const { broker, respond, wait } = harness();
  respond.mockResolvedValueOnce(
    json({ error: { code: 'rate-limit-exceeded', message: 'PRIVATE_PROVIDER_DETAIL' } }, 429, { 'Retry-After': '1' }),
  );
  expect((await broker.getSellableQuantity(account, { market: 'US', symbol: 'AAPL' })).quantity).toBe('100');
  expect(respond).toHaveBeenCalledTimes(2);
  expect(wait).toHaveBeenCalled();
});
it('조회 성공은 종목/전략 소유권이나 주문 권한 플래그를 만들지 않는다', async () => {
  const { broker } = harness();
  const result = await broker.getSellableQuantity(account, { market: 'US', symbol: 'AAPL' });
  expect(result).not.toHaveProperty('canSell');
  expect(result).not.toHaveProperty('ownershipVerified');
  expect(result).not.toHaveProperty('executionEnabled');
});
