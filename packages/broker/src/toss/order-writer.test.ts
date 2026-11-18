import { expect, it, vi } from 'vitest';
import { createTossOrderWriter, normalizeTossLimitOrderRequest } from './index.js';
import { createTossOrderMockSession } from '../testing.js';
import { createTransport } from './transport.js';
import type { TossFetch, TossOptions } from './transport.js';
import type { BrokerAccount, BrokerLimitOrderRequest } from '../index.js';
const account = { reference: '42', type: 'BROKERAGE' };
const uuid = (n = 1) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const request = (n = 1): BrokerLimitOrderRequest => ({
  profile: 'limit-day-integer-v1',
  clientOrderId: uuid(n),
  instrument: { market: 'KR', symbol: '005930' },
  side: 'BUY',
  quantity: '5',
  limitPrice: '70000',
});
const json = (payload: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json', ...headers } });
function harness(extra: Partial<TossOptions> = {}) {
  let time = Date.parse('2026-11-18T00:00:00Z');
  const wait = vi.fn(async (ms: number) => {
    time += ms;
  });
  const acknowledge = (init: RequestInit) => {
    const r = JSON.parse(String(init.body)) as { clientOrderId: string };
    return json({ result: { orderId: `mock-${r.clientOrderId}`, clientOrderId: r.clientOrderId, PRIVATE: 'removed' } });
  };
  const respond = vi.fn(async (init: RequestInit) => acknowledge(init));
  const auth = vi.fn(async () => json({ access_token: 'fake-token', token_type: 'Bearer', expires_in: 3600 }));
  const fetcher = vi.fn<TossFetch>(async (url, init) => {
    expect(new URL(url).origin).toBe('https://toss-writer.invalid');
    if (new URL(url).pathname === '/oauth2/token') return auth();
    if (new URL(url).pathname === '/api/v1/orders' && init.method === 'POST') return respond(init);
    if (new URL(url).pathname === '/api/v1/buying-power' && init.method === 'GET')
      return json({ result: { currency: 'KRW', cashBuyingPower: '1000000' } });
    throw new Error('UNEXPECTED_FAKE_ROUTE');
  });
  const options = {
    clientId: 'fake-client',
    clientSecret: 'fake-secret',
    fetch: fetcher,
    now: () => time,
    wait,
    random: () => 0,
    ...extra,
  };
  const session = createTossOrderMockSession(options);
  return {
    session,
    fetcher,
    respond,
    auth,
    wait,
    options,
    acknowledge,
    advance: (ms: number) => {
      time += ms;
    },
    orderCalls: () =>
      fetcher.mock.calls.filter(([url, init]) => new URL(url).pathname === '/api/v1/orders' && init.method === 'POST'),
  };
}
it('운영 factory는 키/설정/입력과 무관하게 닫혀 있고 어떤 통신도 시작하지 않는다', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('NETWORK_FORBIDDEN'));
  try {
    const writer = createTossOrderWriter();
    expect(writer.mode).toBe('disabled');
    expect(writer.executionEnabled).toBe(false);
    expect(Object.isFrozen(writer)).toBe(true);
    expect(Reflect.set(writer, 'executionEnabled', true)).toBe(false);
    await expect(writer.submitOrder(account, request())).rejects.toMatchObject({ code: 'ORDER_EXECUTION_DISABLED' });
    const configured = Reflect.apply(createTossOrderWriter, null, [
      { enabled: true, executionEnabled: true, clientSecret: 'PRIVATE' },
    ]) as typeof writer;
    await expect(configured.submitOrder(account, request())).rejects.toMatchObject({
      code: 'ORDER_EXECUTION_DISABLED',
    });
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    fetcher.mockRestore();
  }
});
it('운영용 transport의 POST도 인증·전송 전에 거부한다', async () => {
  const fetcher = vi.fn<TossFetch>();
  const transport = createTransport({ clientId: 'fake', clientSecret: 'fake', fetch: fetcher });
  await expect(transport.postOrderOnce('{}', '42')).rejects.toMatchObject({ code: 'ORDER_EXECUTION_DISABLED' });
  expect(fetcher).not.toHaveBeenCalled();
});
it('mock 세션은 명시적 가짜 fetch가 필요하고 native fetch fallback을 허용하지 않는다', () => {
  expect(() => createTossOrderMockSession({ clientId: 'fake', clientSecret: 'fake' } as never)).toThrow(
    'INVALID_INPUT',
  );
  expect(() => createTossOrderMockSession({ clientId: 'fake', clientSecret: 'fake', fetch: globalThis.fetch })).toThrow(
    'INVALID_INPUT',
  );
});
it('정규화는 입력을 바꾸지 않고 경제적으로 같은 표기를 한 번만 직렬화한다', () => {
  const input = {
      ...request(),
      clientOrderId: uuid(0xabcdef).toUpperCase(),
      quantity: '00005',
      limitPrice: '00070000.000',
      instrument: { market: 'KR', symbol: '0101n0' },
    },
    copy = structuredClone(input);
  const canonical = normalizeTossLimitOrderRequest(input);
  expect(canonical).toMatchObject({
    clientOrderId: uuid(0xabcdef),
    quantity: '5',
    limitPrice: '70000',
    instrument: { market: 'KR', symbol: '0101N0' },
  });
  expect(input).toEqual(copy);
  expect(Object.isFrozen(canonical.instrument)).toBe(true);
  expect(Reflect.set(canonical.instrument, 'symbol', 'EVIL')).toBe(false);
});
it('공식 LIMIT/DAY body와 계좌 헤더를 mock origin에 한 번 전송한다', async () => {
  const f = harness();
  const result = await f.session.writer.submitOrder(account, request());
  expect(result).toMatchObject({
    mode: 'mock',
    outcome: 'acknowledged',
    reference: `mock-${uuid()}`,
    clientOrderId: uuid(),
    status: 200,
    replayed: false,
    executionEnabled: false,
    ownershipVerified: false,
    canApplyToLedger: false,
    canResend: false,
  });
  const [url, init] = f.orderCalls()[0]!;
  expect(url).toBe('https://toss-writer.invalid/api/v1/orders');
  expect(JSON.parse(String(init.body))).toEqual({
    clientOrderId: uuid(),
    symbol: '005930',
    side: 'BUY',
    orderType: 'LIMIT',
    timeInForce: 'DAY',
    quantity: '5',
    price: '70000',
    confirmHighValueOrder: false,
  });
  expect(new Headers(init.headers).get('X-Tossinvest-Account')).toBe('42');
  expect(new Headers(init.headers).get('Authorization')).toBe('Bearer fake-token');
  expect(init.redirect).toBe('error');
  expect(result).not.toHaveProperty('state');
  expect(result).not.toHaveProperty('execution');
  expect(result).not.toHaveProperty('PRIVATE');
  expect(result).not.toHaveProperty('requestId');
});
it.each(['0.0001', '0.9999', '1', '1.23', '185.50'])('US 지정가 %s를 native 문자열로 허용한다', async (price) => {
  const f = harness();
  await f.session.writer.submitOrder(account, {
    ...request(),
    instrument: { market: 'US', symbol: 'aapl' },
    side: 'SELL',
    limitPrice: price,
  });
  expect(JSON.parse(String(f.orderCalls()[0]![1].body))).toMatchObject({
    symbol: 'AAPL',
    side: 'SELL',
    price: price === '185.50' ? '185.5' : price,
  });
});
const invalid: Record<string, unknown>[] = [
  { profile: 'market' },
  { clientOrderId: 'arbitrary-key' },
  { clientOrderId: '' },
  { instrument: { market: 'JP', symbol: '1234' } },
  { instrument: { market: 'KR', symbol: 'AAPL' } },
  { instrument: { market: 'US', symbol: 'AAPL/path' } },
  { quantity: '0' },
  { quantity: '-1' },
  { quantity: '1.5' },
  { quantity: '5.0' },
  { quantity: 5 },
  { quantity: '1'.repeat(21) },
  { limitPrice: '0' },
  { limitPrice: '-1' },
  { limitPrice: '1e3' },
  { limitPrice: '70000.01' },
  { instrument: { market: 'US', symbol: 'AAPL' }, limitPrice: '0.00001' },
  { instrument: { market: 'US', symbol: 'AAPL' }, limitPrice: '1.001' },
  { limitPrice: '1'.repeat(31) },
  { orderType: 'MARKET' },
  { timeInForce: 'CLS' },
  { confirmHighValueOrder: true },
  { side: 'SHORT' },
];
it.each(invalid)('지원하지 않는 요청은 토큰 발급 전에 거부한다 %#', async (change) => {
  const f = harness();
  await expect(
    f.session.writer.submitOrder(account, { ...request(), ...change } as BrokerLimitOrderRequest),
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(f.fetcher).not.toHaveBeenCalled();
});
it.each([
  { reference: 'PRIVATE\nACCOUNT', type: 'BROKERAGE' },
  { reference: '42', type: 'OTHER' },
])('잘못된 계좌 문맥은 인증 전에 차단한다', async (bad) => {
  const f = harness();
  await expect(f.session.writer.submitOrder(bad as BrokerAccount, request())).rejects.toMatchObject({
    code: 'INVALID_INPUT',
  });
  expect(f.fetcher).not.toHaveBeenCalled();
});
it('같은 key의 동시 요청과 10분 이후 재조회도 새 네트워크 전송을 만들지 않는다', async () => {
  const f = harness();
  const results = await Promise.all([
    f.session.writer.submitOrder(account, request()),
    f.session.writer.submitOrder(account, request()),
  ]);
  expect(results.map((r) => r.replayed)).toEqual([false, true]);
  expect(f.orderCalls()).toHaveLength(1);
  f.advance(11 * 60_000);
  const replay = await f.session.writer.submitOrder(account, request());
  expect(replay).toMatchObject({ outcome: 'acknowledged', replayed: true });
  expect(f.orderCalls()).toHaveLength(1);
  expect(f.auth).toHaveBeenCalledTimes(1);
});
it('같은 key의 다른 가격/계좌는 거부하고 원래 결과를 변조하지 못한다', async () => {
  const f = harness(),
    result = await f.session.writer.submitOrder(account, request());
  await expect(f.session.writer.submitOrder(account, { ...request(), limitPrice: '71000' })).rejects.toMatchObject({
    code: 'ORDER_ATTEMPT_CONFLICT',
  });
  await expect(f.session.writer.submitOrder({ reference: '43', type: 'BROKERAGE' }, request())).rejects.toMatchObject({
    code: 'ORDER_ATTEMPT_CONFLICT',
  });
  expect(Reflect.set(result, 'reference', 'EVIL')).toBe(false);
  expect((await f.session.writer.submitOrder(account, request())).outcome).toBe('acknowledged');
  expect(f.orderCalls()).toHaveLength(1);
});
it.each([401, 403, 409, 422, 429, 500, 503])(
  'HTTP %s는 원래 주문의 미접수/거절로 단정하거나 재시도하지 않는다',
  async (status) => {
    const f = harness();
    f.respond.mockResolvedValueOnce(
      json({ error: { code: 'request-in-progress', message: 'PRIVATE_DETAIL' } }, status, {
        'Retry-After': '60',
        'X-Request-Id': 'PRIVATE_REQUEST_ID',
      }),
    );
    const result = await f.session.writer.submitOrder(account, request());
    expect(result).toMatchObject({ outcome: 'unknown', status, canResend: false });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(f.orderCalls()).toHaveLength(1);
    expect(f.auth).toHaveBeenCalledTimes(1);
    expect(f.wait).not.toHaveBeenCalled();
    expect((await f.session.writer.submitOrder(account, request())).replayed).toBe(true);
    expect(f.orderCalls()).toHaveLength(1);
    expect(f.auth).toHaveBeenCalledTimes(1);
  },
);
it.each([
  {},
  { result: {} },
  { result: { orderId: 'x' } },
  { result: { orderId: 'x', clientOrderId: null } },
  { result: { orderId: 'x', clientOrderId: uuid(2) } },
  ...['', '.', '..', 'bad\nref', 'a'.repeat(513)].map((orderId) => ({ result: { orderId, clientOrderId: uuid() } })),
])('불완전/불일치 200 응답은 미확인으로 보존한다 %#', async (payload) => {
  const f = harness();
  f.respond.mockResolvedValueOnce(json(payload));
  expect(await f.session.writer.submitOrder(account, request())).toMatchObject({
    outcome: 'unknown',
    code: 'INVALID_RESPONSE',
    status: 200,
  });
  expect(f.orderCalls()).toHaveLength(1);
});
it('깨진 JSON과 명세에 없는 201을 접수 성공으로 바꾸지 않는다', async () => {
  for (const response of [
    new Response('not-json', { status: 200 }),
    json({ result: { orderId: 'x', clientOrderId: uuid() } }, 201),
  ]) {
    const f = harness();
    f.respond.mockResolvedValueOnce(response);
    expect(await f.session.writer.submitOrder(account, request())).toMatchObject({
      outcome: 'unknown',
      code: 'INVALID_RESPONSE',
    });
    expect(f.orderCalls()).toHaveLength(1);
  }
});
it('fetch 진입 뒤 네트워크 오류는 접수 여부를 추정하지 않고 원문을 제거한다', async () => {
  const f = harness();
  f.respond.mockRejectedValueOnce(new Error('PRIVATE_NETWORK_FAILURE'));
  const result = await f.session.writer.submitOrder(account, request());
  expect(result).toMatchObject({ outcome: 'unknown', code: 'NETWORK_ERROR' });
  expect(JSON.stringify(result)).not.toContain('PRIVATE');
  expect((await f.session.writer.submitOrder(account, request())).replayed).toBe(true);
  expect(f.orderCalls()).toHaveLength(1);
});
it('인증 실패는 이 시도의 주문 POST 미진입으로 구분하고 같은 key로 인증을 재시도하지 않는다', async () => {
  const f = harness();
  f.auth.mockResolvedValueOnce(json({}, 403));
  expect(await f.session.writer.submitOrder(account, request())).toMatchObject({
    outcome: 'not-sent',
    code: 'PERMISSION_DENIED',
    status: 403,
    canResend: false,
  });
  expect((await f.session.writer.submitOrder(account, request())).replayed).toBe(true);
  expect(f.orderCalls()).toHaveLength(0);
  expect(f.auth).toHaveBeenCalledTimes(1);
});
it('사전 취소는 인증/주문 전송 전에 종료한다', async () => {
  const f = harness({ signal: AbortSignal.abort() });
  expect(await f.session.writer.submitOrder(account, request())).toMatchObject({
    outcome: 'not-sent',
    code: 'CANCELLED',
  });
  expect(f.fetcher).not.toHaveBeenCalled();
});
it('주문 fetch 중 취소는 unknown이며 자동 후속 전송을 만들지 않는다', async () => {
  const controller = new AbortController(),
    f = harness({ signal: controller.signal });
  f.respond.mockImplementationOnce(async () => {
    controller.abort();
    throw new Error('PRIVATE_CANCEL');
  });
  expect(await f.session.writer.submitOrder(account, request())).toMatchObject({
    outcome: 'unknown',
    code: 'CANCELLED',
  });
  expect(f.orderCalls()).toHaveLength(1);
});
it('정상 body를 이미 받은 뒤 취소된 사실이 접수 근거를 지우지 않는다', async () => {
  const controller = new AbortController(),
    f = harness({ signal: controller.signal });
  f.respond.mockImplementationOnce(async (init) => {
    controller.abort();
    return f.acknowledge(init);
  });
  expect(await f.session.writer.submitOrder(account, request())).toMatchObject({
    outcome: 'acknowledged',
    canResend: false,
  });
});
it('주문 timeout도 한 번의 모호한 요청으로 보존한다', async () => {
  const f = harness({ timeoutMs: 100 });
  f.respond.mockImplementationOnce(
    (init) =>
      new Promise((_, reject) => {
        init.signal!.addEventListener('abort', () => reject(new Error('PRIVATE_TIMEOUT')), { once: true });
      }),
  );
  expect(await f.session.writer.submitOrder(account, request())).toMatchObject({ outcome: 'unknown', code: 'TIMEOUT' });
  expect(f.orderCalls()).toHaveLength(1);
});
it('읽기와 writer가 같은 session의 token manager를 공유한다', async () => {
  const f = harness();
  await Promise.all([
    f.session.readonly.getBuyingPower(account, 'KRW'),
    f.session.writer.submitOrder(account, request()),
  ]);
  expect(f.auth).toHaveBeenCalledTimes(1);
  expect(f.session.readonly).not.toHaveProperty('submitOrder');
  expect(f.fetcher.mock.calls.every(([url]) => new URL(url).hostname === 'toss-writer.invalid')).toBe(true);
});
it('주문 한도 header는 다음 다른 시도를 늦추되 같은 시도를 재전송하지 않는다', async () => {
  const f = harness();
  f.respond.mockResolvedValueOnce(
    json({ result: { orderId: 'x', clientOrderId: uuid() } }, 200, {
      'X-RateLimit-Limit': '2',
      'X-RateLimit-Remaining': '0',
      'X-RateLimit-Reset': '1',
    }),
  );
  await f.session.writer.submitOrder(account, request());
  await f.session.writer.submitOrder(account, request(2));
  expect(f.wait).toHaveBeenCalledWith(1000);
  expect(f.orderCalls()).toHaveLength(2);
});
it('origin 추가 옵션으로 실제 호스트를 열지 못하며 mock 요청 이력 256개 뒤 새 key를 차단한다', async () => {
  const f = harness({ baseUrl: 'https://openapi.tossinvest.com' } as Partial<TossOptions>);
  for (let n = 1; n <= 256; n++) await f.session.writer.submitOrder(account, request(n));
  await expect(f.session.writer.submitOrder(account, request(257))).rejects.toMatchObject({
    code: 'ORDER_ATTEMPT_LIMIT',
  });
  expect((await f.session.writer.submitOrder(account, request())).replayed).toBe(true);
  expect(f.orderCalls()).toHaveLength(256);
});
