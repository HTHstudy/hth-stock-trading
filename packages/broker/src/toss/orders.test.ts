import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import type { BrokerOrderLookup } from '../index.js';
import { createTossReadonlyBroker } from './index.js';
import type { TossFetch } from './index.js';
import { createTransport } from './transport.js';

type OrderExample = {
  orderId: string;
  symbol: string;
  side: string;
  orderType: string;
  timeInForce: string;
  status: string;
  price: string | null;
  quantity: string;
  orderAmount: string | null;
  currency: string;
  orderedAt: string;
  canceledAt: string | null;
  execution: {
    filledQuantity: string;
    averageFilledPrice: string | null;
    filledAmount: string | null;
    commission: string | null;
    tax: string | null;
    filledAt: string | null;
    settlementDate: string | null;
  };
};
const examples = JSON.parse(readFileSync(new URL('../../test/order-fixtures.json', import.meta.url), 'utf8')) as {
  pages: Record<string, { result: { orders: OrderExample[]; nextCursor: string | null; hasNext: boolean } }>;
  details: Record<string, { result: OrderExample }>;
};
const account = { reference: '123456789', type: 'BROKERAGE' };
const token = 'fake-order-read-token';
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const base = examples.details.krLimitFilled!.result;
function harness(payload: unknown = { result: base }) {
  let clock = Date.parse('2026-11-11T00:00:00Z');
  const wait = vi.fn(async (ms: number) => {
    clock += ms;
  });
  const respond = vi.fn(async () => json(payload));
  const fetcher = vi.fn<TossFetch>(async (url, init) => {
    if (new URL(url).pathname === '/oauth2/token' && init.method === 'POST')
      return json({ access_token: token, token_type: 'Bearer', expires_in: 3600 });
    if (new URL(url).pathname.startsWith('/api/v1/orders') && init.method === 'GET') return respond();
    throw new Error('FAKE_ROUTE_REJECTED');
  });
  const options = {
    clientId: 'fake-client',
    clientSecret: 'fake-secret',
    fetch: fetcher,
    now: () => clock,
    wait,
    random: () => 0,
  };
  return { broker: createTossReadonlyBroker(options), fetcher, respond, wait, options };
}
it.each(Object.entries(examples.details))('공식 상세 예제 %s를 누적 체결 값 그대로 정규화한다', async (_, value) => {
  const f = harness(value);
  const port: BrokerOrderLookup = f.broker;
  const row = await port.getOrder(account, value.result.orderId);
  expect(row.reference).toBe(value.result.orderId);
  expect(row.instrument).toEqual({
    market: value.result.currency === 'KRW' ? 'KR' : 'US',
    symbol: value.result.symbol,
  });
  expect(row.status).toEqual({ value: value.result.status, known: true });
  expect(row.execution).toEqual({
    quantity: value.result.execution.filledQuantity,
    averagePrice: value.result.execution.averageFilledPrice,
    amount: value.result.execution.filledAmount,
    commission: value.result.execution.commission,
    tax: value.result.execution.tax,
    lastFilledAt:
      value.result.execution.filledAt === null ? null : new Date(value.result.execution.filledAt).toISOString(),
    settlementDate: value.result.execution.settlementDate,
  });
  const [url, init] = f.fetcher.mock.calls[1]!;
  expect(url).toBe('https://openapi.tossinvest.com/api/v1/orders/' + value.result.orderId);
  expect(init.method).toBe('GET');
  expect(init.body).toBeUndefined();
  expect(init.redirect).toBe('error');
  expect(new Headers(init.headers).get('X-Tossinvest-Account')).toBe(account.reference);
});
it.each(Object.entries(examples.pages))('공식 목록 예제 %s와 cursor를 보존한다', async (name, value) => {
  const f = harness(value);
  const group = name === 'completedWithNextPage' ? 'CLOSED' : 'OPEN';
  const page = await f.broker.getOrders(account, { group });
  expect(page.orders).toHaveLength(value.result.orders.length);
  expect(page.requestedGroup).toBe(group);
  expect(page.nextCursor).toBe(value.result.nextCursor);
  expect(page.hasNext).toBe(value.result.hasNext);
});
it('CLOSED에 포함된 부분 체결을 완료 상태로 바꾸지 않는다', async () => {
  const row = examples.details.usMarketPartialFilled!.result;
  const f = harness({ result: { orders: [row], nextCursor: null, hasNext: false } });
  const result = await f.broker.getOrders(account, { group: 'CLOSED' });
  expect(result.orders[0]!.status).toEqual({ value: 'PARTIAL_FILLED', known: true });
  expect(result.orders[0]).not.toHaveProperty('terminal');
});
it('미지 상태/호가/유효 조건은 unknown 코드로 보존하고 상태 전이를 승인하지 않는다', async () => {
  const f = harness({
    result: { ...base, status: 'FUTURE_STATUS', orderType: 'FUTURE_TYPE', timeInForce: 'FUTURE_TIF' },
  });
  const row = await f.broker.getOrder(account, base.orderId);
  expect([row.status, row.type, row.validity]).toEqual(
    ['FUTURE_STATUS', 'FUTURE_TYPE', 'FUTURE_TIF'].map((value) => ({ value, known: false })),
  );
});
it('옵션 필드 누락과 명시적 null·누적 비용의 null/0을 구분한다', async () => {
  const without: Partial<OrderExample> = { ...base };
  delete without.price;
  delete without.orderAmount;
  delete without.canceledAt;
  const f = harness({ result: { ...without, execution: { ...base.execution, commission: null, tax: '0' } } });
  const row = await f.broker.getOrder(account, base.orderId);
  expect(row).not.toHaveProperty('limitPrice');
  expect(row).not.toHaveProperty('requestedAmount');
  expect(row).not.toHaveProperty('canceledAt');
  expect(row.execution.commission).toBeNull();
  expect(row.execution.tax).toBe('0');
});
it('십진 수량·평균가·금액을 number로 변환하거나 임의 재계산하지 않는다', async () => {
  const quantity = '0.0000000000000000000000000001';
  const f = harness({
    result: {
      ...base,
      quantity,
      execution: { ...base.execution, filledQuantity: quantity, averageFilledPrice: '1.1234567890123456789012345678' },
    },
  });
  const row = await f.broker.getOrder(account, base.orderId);
  expect(row.requestedQuantity).toBe(quantity);
  expect(row.execution.quantity).toBe(quantity);
  expect(row.execution.averagePrice).toBe('1.1234567890123456789012345678');
});
it('폐쇄 목록의 symbol·KST 날짜·limit·opaque cursor를 인코딩하고 계좌는 헤더로만 보낸다', async () => {
  const row = { ...base, orderedAt: '2026-03-29T00:15:00+09:00' };
  const f = harness({ result: { orders: [row], nextCursor: null, hasNext: false } });
  await f.broker.getOrders(account, {
    group: 'CLOSED',
    symbol: '005930',
    from: '2026-03-29',
    to: '2026-03-29',
    limit: 1,
    cursor: 'a+/= &status=OPEN',
  });
  const url = new URL(f.fetcher.mock.calls[1]![0]);
  expect(Object.fromEntries(url.searchParams)).toEqual({
    status: 'CLOSED',
    symbol: '005930',
    from: '2026-03-29',
    to: '2026-03-29',
    limit: '1',
    cursor: 'a+/= &status=OPEN',
  });
  expect(url.href).not.toContain(account.reference);
});
it('opaque 주문 ID를 단일 경로 조각으로 인코딩한다', async () => {
  const id = 'opaque/with?#% and spaces/한글😀';
  const f = harness({ result: { ...base, orderId: id } });
  await f.broker.getOrder(account, id);
  const url = new URL(f.fetcher.mock.calls[1]![0]);
  expect(url.pathname).toBe('/api/v1/orders/' + encodeURIComponent(id));
  expect(url.search).toBe('');
  expect(url.hash).toBe('');
});
it.each(['', '.', '..', 'x\nPRIVATE_ACCOUNT', 'x'.repeat(513), String.fromCharCode(0xd800)])(
  '잘못된 주문 ID는 토큰 발급 전에 거부한다 %j',
  async (id) => {
    const f = harness();
    await expect(f.broker.getOrder(account, id)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(f.fetcher).not.toHaveBeenCalled();
  },
);
it.each([
  {},
  { group: 'ALL' },
  { group: 'OPEN', limit: 1 },
  { group: 'OPEN', cursor: 'x' },
  { group: 'CLOSED', limit: 0 },
  { group: 'CLOSED', limit: 101 },
  { group: 'CLOSED', limit: 1.5 },
  { group: 'CLOSED', cursor: '' },
  { group: 'CLOSED', cursor: String.fromCharCode(0xd800) },
  { group: 'OPEN', from: '2026-02-29' },
  { group: 'OPEN', from: '2026-04-01', to: '2026-03-01' },
  { group: 'OPEN', symbol: 'x&status=CLOSED' },
])('목록 입력을 토큰 발급 전에 검증한다 %j', async (query) => {
  const f = harness();
  await expect(f.broker.getOrders(account, query as never)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(f.fetcher).not.toHaveBeenCalled();
});
it.each(['-1', 'bad', '12345678901234567', '1\nInjected:x'])(
  '잘못된 계좌를 토큰 발급 전에 거부한다 %j',
  async (reference) => {
    const f = harness();
    await expect(f.broker.getOrder({ ...account, reference }, base.orderId)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(f.fetcher).not.toHaveBeenCalled();
  },
);
it.each([
  { orderId: 'different' },
  { status: String.fromCharCode(0xd800) },
  { quantity: 1 },
  { quantity: '-1' },
  { price: '1e2' },
  { currency: 'JPY' },
  { orderedAt: 'not-a-date' },
  { side: 'FUTURE_SIDE' },
  { status: '' },
  { execution: { ...base.execution, commission: undefined } },
  { execution: { ...base.execution, filledQuantity: 'NaN' } },
  { execution: { ...base.execution, tax: '-0' } },
  { execution: { ...base.execution, settlementDate: '2026-02-29' } },
])('잘못된 상세 응답은 원문을 노출하지 않고 거부한다 %j', async (patch) => {
  const f = harness({ result: { ...base, ...patch } });
  await expect(f.broker.getOrder(account, base.orderId)).rejects.toMatchObject({
    code: 'INVALID_RESPONSE',
    message: 'INVALID_RESPONSE',
  });
});
it.each([
  { orders: [base, base], nextCursor: null, hasNext: false },
  { orders: [base], nextCursor: 'cursor', hasNext: false },
  { orders: [base], nextCursor: null, hasNext: true },
  { orders: [base], nextCursor: 'cursor', hasNext: true },
])('OPEN 목록의 중복/불확실 페이지 응답을 거부한다 %j', async (result) => {
  const f = harness({ result });
  await expect(f.broker.getOrders(account, { group: 'OPEN' })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
});
it('CLOSED limit 초과와 symbol/날짜 범위 불일치를 거부한다', async () => {
  const f = harness({ result: { orders: [base, { ...base, orderId: 'second' }], nextCursor: null, hasNext: false } });
  await expect(f.broker.getOrders(account, { group: 'CLOSED', limit: 1 })).rejects.toMatchObject({
    code: 'INVALID_RESPONSE',
  });
  const mismatch = harness({ result: { orders: [base], nextCursor: null, hasNext: false } });
  await expect(mismatch.broker.getOrders(account, { group: 'OPEN', symbol: 'AAPL' })).rejects.toMatchObject({
    code: 'INVALID_RESPONSE',
  });
  await expect(mismatch.broker.getOrders(account, { group: 'OPEN', from: '2026-04-01' })).rejects.toMatchObject({
    code: 'INVALID_RESPONSE',
  });
});
it('계좌/인증 원본 필드를 projection에서 제거하고 재전송 권한을 만들지 않는다', async () => {
  const f = harness({ access_token: token, result: { ...base, accountNo: account.reference, access_token: token } });
  const row = await f.broker.getOrder(account, base.orderId);
  expect(JSON.stringify(row)).not.toContain(token);
  expect(JSON.stringify(row)).not.toContain(account.reference);
  expect(row).not.toHaveProperty('clientOrderId');
  expect(row).not.toHaveProperty('strategyId');
  expect(f.broker).not.toHaveProperty('submitOrder');
  expect(f.broker).not.toHaveProperty('cancelOrder');
});
it('목록/상세는 같은 token manager와 ORDER_HISTORY 5TPS 제한을 공유한다', async () => {
  const f = harness();
  f.respond.mockResolvedValueOnce(json(examples.pages.empty));
  await f.broker.getOrders(account, { group: 'OPEN' });
  await f.broker.getOrder(account, base.orderId);
  await f.broker.getOrder(account, base.orderId);
  expect(f.fetcher.mock.calls.filter(([url]) => url.endsWith('/oauth2/token'))).toHaveLength(1);
  expect(f.wait.mock.calls.map(([ms]) => ms)).toEqual([200, 200]);
  expect(f.fetcher.mock.calls.every(([url, init]) => url.endsWith('/oauth2/token') || init.method === 'GET')).toBe(
    true,
  );
});
it.each([
  [404, 'UPSTREAM_REJECTED', 1],
  [403, 'PERMISSION_DENIED', 1],
  [429, 'RATE_LIMITED', 3],
  [500, 'UPSTREAM_UNAVAILABLE', 3],
  [401, 'AUTHENTICATION_FAILED', 2],
] as const)('HTTP %s 오류는 조회 재시도 상한과 비밀값 비노출을 유지한다', async (status, code, attempts) => {
  const f = harness();
  f.respond.mockImplementation(async () => json({ error: { message: token + ' ' + account.reference } }, status));
  const failure: unknown = await f.broker.getOrder(account, base.orderId).catch((error: unknown) => error);
  expect(failure).toMatchObject({ code, status, message: code });
  expect(JSON.stringify(failure)).not.toContain(token);
  expect(JSON.stringify(failure)).not.toContain(account.reference);
  expect(f.respond).toHaveBeenCalledTimes(attempts);
});
it('취소된 조회는 토큰을 발급하지 않는다', async () => {
  const f = harness();
  const broker = createTossReadonlyBroker({ ...f.options, signal: AbortSignal.abort() });
  await expect(broker.getOrder(account, base.orderId)).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(f.fetcher).not.toHaveBeenCalled();
});
it.each([
  '/api/v1/orders/../cancel',
  '/api/v1/orders/%2E%2E',
  '/api/v1/orders/foo/cancel',
  '/api/v1/orders/%zz',
] as const)('transport는 비정규 동적 경로를 인증 전에 거부한다 %s', async (path) => {
  const f = harness();
  const transport = createTransport(f.options);
  const { z } = await import('zod');
  await expect(transport.get(path, 'ORDER_HISTORY', z.unknown())).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(f.fetcher).not.toHaveBeenCalled();
});
