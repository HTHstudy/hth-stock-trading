import { describe, expect, it, vi } from 'vitest';
import { createHarness, fixtures, jsonResponse } from '../../test/harness.js';
import { createTossReadonlyBroker } from './index.js';

const instruments = [
  { market: 'KR', symbol: '005930' },
  { market: 'US', symbol: 'AAPL' },
] as const;
const query = { instrument: instruments[0], interval: '1m', count: 200, adjusted: false } as const;

describe('Toss read-only adapter', () => {
  it('공식 예제의 계좌·보유분·종목·시세·매수가능금액을 정규화하고 토큰을 공유한다', async () => {
    const { broker, fetcher } = createHarness();
    const accounts = await broker.listAccounts();
    expect(accounts).toEqual([{ reference: '1', type: 'BROKERAGE' }]);
    expect(JSON.stringify(accounts)).not.toContain('accountNo');
    const account = accounts[0]!;
    expect((await broker.getHoldings(account)).map((holding) => holding.instrument.market)).toEqual(['KR', 'US']);
    expect((await broker.getInstruments(instruments)).map((instrument) => instrument.currency)).toEqual(['KRW', 'USD']);
    expect((await broker.getQuotes(instruments))[0]).toMatchObject({
      price: '72000',
      timestamp: '2026-03-25T00:30:00.123Z',
    });
    expect(await broker.getBuyingPower(account, 'USD')).toEqual({ currency: 'USD', amount: '5000000' });
    const authCalls = fetcher.mock.calls.filter(([url]) => new URL(url).pathname === '/oauth2/token');
    expect(authCalls).toHaveLength(1);
    const auth = authCalls[0]![1];
    expect(auth.method).toBe('POST');
    expect(new URLSearchParams(String(auth.body)).get('grant_type')).toBe('client_credentials');
    for (const [url, init] of fetcher.mock.calls) {
      expect(new URL(url).origin).toBe('https://openapi.tossinvest.com');
      expect(init.redirect).toBe('error');
      if (url.includes('/holdings') || url.includes('/buying-power'))
        expect(new Headers(init.headers).get('X-Tossinvest-Account')).toBe('1');
      if (!url.includes('/oauth2/token')) expect(init.method).toBe('GET');
      expect(url).not.toMatch(/orders|conditional-orders/);
    }
  });

  it('캔들 정렬·중복 제거·UTC 변환을 수행하고 완료 여부를 추측하지 않는다', async () => {
    const { broker, fetcher } = createHarness();
    fetcher.mockImplementationOnce(async () =>
      jsonResponse({ access_token: 'fixture-token', token_type: 'Bearer', expires_in: 3600 }),
    );
    fetcher.mockImplementationOnce(async () =>
      jsonResponse({
        result: {
          ...fixtures.candles.result,
          candles: [...fixtures.candles.result.candles, fixtures.candles.result.candles[0]],
        },
      }),
    );
    const page = await broker.getCandles({ ...query, before: '2026-03-25T09:33:00+09:00' });
    expect(page.candles.map((candle) => candle.timestamp)).toEqual([
      '2026-03-25T00:31:00.000Z',
      '2026-03-25T00:32:00.000Z',
    ]);
    expect(page.candles.every((candle) => candle.isClosed === false && candle.tradingDate === '2026-03-25')).toBe(true);
    expect(page.nextBefore).toBe(fixtures.candles.result.nextBefore);
    const request = new URL(fetcher.mock.calls[1]![0]);
    expect(request.search).toContain('%2B09%3A00');
    expect(request.searchParams.get('adjusted')).toBe('false');
  });

  it.each([
    ['2026-03-24T23:59:00-04:00', '2026-03-25'],
    ['2026-03-25T20:00:00-04:00', '2026-03-25'],
    ['2026-03-25T20:01:00-04:00', '2026-03-26'],
    ['2026-11-02T20:01:00-05:00', '2026-11-03'],
  ])('미국 분봉 %s의 거래일은 %s다', async (timestamp, date) => {
    const { broker, fetcher } = createHarness();
    fetcher.mockImplementationOnce(async () =>
      jsonResponse({ access_token: 'fixture-token', token_type: 'Bearer', expires_in: 3600 }),
    );
    fetcher.mockImplementationOnce(async () =>
      jsonResponse({
        result: { candles: [{ ...fixtures.candles.result.candles[0], currency: 'USD', timestamp }], nextBefore: null },
      }),
    );
    const page = await broker.getCandles({ ...query, instrument: instruments[1] });
    expect(page.candles[0]?.tradingDate).toBe(date);
  });

  it('환율과 KR/US 시장 일정의 시간대를 정규화한다', async () => {
    const { broker } = createHarness();
    expect(await broker.getExchangeRate('USD', 'KRW')).toMatchObject({
      rate: '1380.5',
      validUntil: '2026-03-25T00:31:00.000Z',
    });
    expect((await broker.getMarketCalendar('KR')).today).toMatchObject({
      sessionsKnown: true,
      tradingDate: '2026-03-25',
    });
    const calendar = await broker.getMarketCalendar('US', '2026-03-25');
    expect(calendar.today.sessions).toHaveLength(4);
    expect(calendar.today.sessions.find((session) => session.type === 'regular')).toMatchObject({
      startsAt: '2026-03-25T13:30:00.000Z',
      endsAt: '2026-03-25T20:00:00.000Z',
    });
  });

  it('휴장 null과 미제공 세션을 구분한다', async () => {
    const { broker, fetcher } = createHarness();
    await broker.listAccounts();
    fetcher.mockImplementationOnce(async () => jsonResponse(fixtures.krHoliday));
    expect((await broker.getMarketCalendar('KR')).today).toMatchObject({ sessionsKnown: true, sessions: [] });
    fetcher.mockImplementationOnce(async () => jsonResponse(fixtures.usHoliday));
    expect((await broker.getMarketCalendar('US')).today).toMatchObject({ sessionsKnown: true, sessions: [] });
    fetcher.mockImplementationOnce(async () =>
      jsonResponse({
        result: {
          today: { date: '2026-03-25' },
          previousBusinessDay: { date: '2026-03-24' },
          nextBusinessDay: { date: '2026-03-26' },
        },
      }),
    );
    expect((await broker.getMarketCalendar('US')).today).toMatchObject({ sessionsKnown: false, sessions: [] });
  });

  it('시세 timestamp null은 수신 시각으로 대체하지 않는다', async () => {
    const { broker, fetcher } = createHarness();
    await broker.listAccounts();
    fetcher.mockImplementationOnce(async () =>
      jsonResponse({ result: [{ ...fixtures.quotes.result[0], timestamp: null }] }),
    );
    expect((await broker.getQuotes([instruments[0]]))[0]?.timestamp).toBeNull();
  });

  it('알 수 없는 계좌 유형은 보존하지만 지원하지 않는 거래 통화는 거부한다', async () => {
    const { broker, fetcher } = createHarness();
    await broker.listAccounts();
    fetcher.mockImplementationOnce(async () =>
      jsonResponse({ result: [{ accountSeq: 2, accountType: 'FUTURE_TYPE' }] }),
    );
    expect((await broker.listAccounts())[0]?.type).toBe('FUTURE_TYPE');
    fetcher.mockImplementationOnce(async () =>
      jsonResponse({ result: [{ symbol: '005930', currency: 'EUR', lastPrice: '1' }] }),
    );
    await expect(broker.getQuotes([instruments[0]])).rejects.toMatchObject({ code: 'UNSUPPORTED_MARKET' });
  });

  it('잘못된 입력은 인증 요청 전에 차단한다', async () => {
    const { broker, fetcher } = createHarness();
    await expect(broker.getCandles({ ...query, count: 201 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(broker.getQuotes([{ market: 'US', symbol: 'AAPL&secret=oops' }])).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(broker.getQuotes([instruments[0], instruments[0]])).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(broker.getHoldings({ reference: '1\r\nInjected: x', type: 'BROKERAGE' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    { result: [{ symbol: '005930', currency: 'USD', lastPrice: '72000' }] },
    { result: [{ symbol: '005930', currency: 'KRW', lastPrice: 72000 }] },
    { result: [] },
  ])('통화 불일치·정밀도 손실·누락 응답은 거부한다', async (payload) => {
    const { broker, fetcher } = createHarness();
    await broker.listAccounts();
    fetcher.mockImplementationOnce(async () => jsonResponse(payload));
    await expect(broker.getQuotes([instruments[0]])).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('비정상 OHLC와 같은 시각의 상충하는 캔들을 거부한다', async () => {
    const { broker, fetcher } = createHarness();
    await broker.listAccounts();
    fetcher.mockImplementationOnce(async () =>
      jsonResponse({ result: { candles: [{ ...fixtures.candles.result.candles[0], highPrice: '1' }] } }),
    );
    await expect(broker.getCandles(query)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    const candle = fixtures.candles.result.candles[0]!;
    fetcher.mockImplementationOnce(async () =>
      jsonResponse({ result: { candles: [candle, { ...candle, volume: '99999' }] } }),
    );
    await expect(broker.getCandles(query)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});

describe('토큰·재시도·호출 제한', () => {
  it('동시 요청이 토큰을 한 번만 발급하고 만료 전에 갱신한다', async () => {
    const { broker, fetcher, advance } = createHarness();
    await Promise.all([broker.listAccounts(), broker.getQuotes(instruments), broker.getMarketCalendar('KR')]);
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith('/oauth2/token'))).toHaveLength(1);
    advance(3_550_000);
    await broker.listAccounts();
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith('/oauth2/token'))).toHaveLength(2);
  });

  it('401은 한 번 갱신하고 계속 거부되면 중단한다', async () => {
    let authCount = 0;
    const { broker, fetcher } = createHarness(async (url) => {
      if (url.endsWith('/oauth2/token'))
        return jsonResponse({ access_token: `token-${++authCount}`, token_type: 'Bearer', expires_in: 3600 });
      return jsonResponse({ error: { code: 'expired-token' } }, 401);
    });
    await expect(broker.listAccounts()).rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' });
    expect(authCount).toBe(2);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('429의 Retry-After와 그룹별 속도 제한을 따른다', async () => {
    const { broker, fetcher, waits } = createHarness();
    await broker.listAccounts();
    fetcher.mockImplementationOnce(async () =>
      jsonResponse({}, 429, {
        'Retry-After': '4',
        'X-RateLimit-Limit': '1',
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': '2',
      }),
    );
    await broker.listAccounts();
    expect(waits).toContain(4000);
    expect(waits.some((delay) => delay >= 1000)).toBe(true);
    expect(fetcher.mock.calls.filter(([url]) => url.includes('/accounts'))).toHaveLength(3);
  });

  it('긴 Retry-After는 조기 재시도하지 않고 호출자에게 실패를 반환한다', async () => {
    const { broker, fetcher } = createHarness();
    await broker.listAccounts();
    fetcher.mockImplementationOnce(async () => jsonResponse({}, 429, { 'Retry-After': '120' }));
    await expect(broker.listAccounts()).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    await expect(broker.listAccounts()).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(fetcher.mock.calls.filter(([url]) => url.includes('/accounts'))).toHaveLength(2);
  });

  it('서버 장애는 최대 3회, 403은 재시도 없이 실패한다', async () => {
    const { broker, fetcher } = createHarness();
    await broker.listAccounts();
    for (let attempt = 0; attempt < 3; attempt += 1)
      fetcher.mockImplementationOnce(async () => new Response('maintenance', { status: 503 }));
    await expect(broker.listAccounts()).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
    expect(fetcher.mock.calls.filter(([url]) => url.includes('/accounts'))).toHaveLength(4);
    fetcher.mockImplementationOnce(async () =>
      jsonResponse({ error: { message: 'fixture-secret account-number' } }, 403, { 'X-Request-Id': 'safe-request-id' }),
    );
    await expect(broker.listAccounts()).rejects.toMatchObject({
      message: 'PERMISSION_DENIED',
      requestId: 'safe-request-id',
    });
  });

  it('네트워크 오류에 포함된 URL·키를 오류에 노출하지 않는다', async () => {
    const { broker } = createHarness(async () => {
      throw new Error('fixture-secret client_id=private accountNo=123');
    });
    try {
      await broker.listAccounts();
      throw new Error('Expected failure');
    } catch (error) {
      expect(error).toMatchObject({ code: 'NETWORK_ERROR' });
      expect(JSON.stringify(error)).not.toMatch(/fixture-secret|accountNo|client_id/);
      expect(String(error)).toBe('BrokerError: NETWORK_ERROR');
    }
  });

  it('네트워크 타임아웃과 취소를 구분한다', async () => {
    const fetcher = vi.fn(
      async (_url: string, init: RequestInit): Promise<Response> =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    );
    const broker = createTossReadonlyBroker({
      clientId: 'fixture',
      clientSecret: 'fixture',
      fetch: fetcher,
      timeoutMs: 10,
    });
    await expect(broker.listAccounts()).rejects.toMatchObject({ code: 'TIMEOUT' });
    const controller = new AbortController();
    controller.abort();
    const cancelled = createTossReadonlyBroker({
      clientId: 'fixture',
      clientSecret: 'fixture',
      fetch: fetcher,
      signal: controller.signal,
    });
    await expect(cancelled.listAccounts()).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
