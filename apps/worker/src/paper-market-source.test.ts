import { describe, expect, it, vi } from 'vitest';
import type { Candle, MarketCalendar, PaperEvidence } from '@hth/contracts';
import { movingAverageCross, prepareStrategyData } from '@hth/trading';
import { createHarness } from '../../../packages/broker/test/harness.js';
import { createPaperMarketSource } from './paper-market-source.js';

const instruments = [
  { market: 'KR', symbol: '005930' },
  { market: 'US', symbol: 'AAPL' },
] as const;
const now = () => Date.parse('2026-03-25T00:33:00Z');
const signal = () => new AbortController().signal;
function setup() {
  const harness = createHarness();
  vi.spyOn(harness.broker, 'getQuotes').mockResolvedValue(
    instruments.map((instrument) => ({
      instrument,
      price: '72000',
      currency: instrument.market === 'KR' ? 'KRW' : 'USD',
      timestamp: '2026-03-25T00:32:50Z',
    })),
  );
  return { ...harness, source: createPaperMarketSource(harness.broker, 1, now) };
}
function prepare(entry: PaperEvidence) {
  return prepareStrategyData({
    ...entry.marketData,
    instrument: entry.quote.instrument,
    quoteTimestamp: entry.quote.timestamp,
    quoteObservedAt: entry.quote.observedAt,
    accountAvailable: true,
    accountObservedAt: new Date(now()).toISOString(),
    asOf: new Date(now()).toISOString(),
  });
}

describe('실제 시세용 Paper source (네트워크 없는 fixture)', () => {
  it('KR/US 시장 데이터만 반환하며 실제 계좌/잔고를 조회하지 않는다', async () => {
    const { source, broker, fetcher } = setup();
    const accounts = vi.spyOn(broker, 'listAccounts');
    const holdings = vi.spyOn(broker, 'getHoldings');
    const buyingPower = vi.spyOn(broker, 'getBuyingPower');
    const result = (await source(instruments, signal())) as PaperEvidence[];
    expect(result).toHaveLength(2);
    expect(result.map((entry) => entry.quote.instrument)).toEqual(instruments);
    expect(result.every((entry) => entry.sourcesHealthy && !entry.hasUnknownOrders)).toBe(true);
    expect(result.every((entry) => entry.marketData.candles.every((candle) => !candle.isClosed))).toBe(true);
    expect(accounts).not.toHaveBeenCalled();
    expect(holdings).not.toHaveBeenCalled();
    expect(buyingPower).not.toHaveBeenCalled();
    expect(
      fetcher.mock.calls.every(([url, init]) => init.method === 'GET' || new URL(url).pathname === '/oauth2/token'),
    ).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/accountNo|reference|buyingPower|fixture-token/);
  });

  it('봉 확정과 KR/US 세션 판단을 기존 준비 검사에 위임한다', async () => {
    const { source, broker } = setup();
    const fx = await broker.getExchangeRate('USD', 'KRW');
    vi.spyOn(broker, 'getExchangeRate').mockResolvedValue({
      ...fx,
      validFrom: '2026-03-25T00:00:00Z',
      validUntil: '2026-03-25T01:00:00Z',
    });
    const result = (await source(instruments, signal())) as PaperEvidence[];
    expect(prepare(result[0]!).ready).toBe(true);
    expect(prepare(result[1]!).blockers).toContain('MARKET_CLOSED');
    expect(result[0]!.marketData.candles.every((candle) => !candle.isClosed)).toBe(true);
  });

  it('누락된 시세 시각을 관측 시각으로 위조하지 않는다', async () => {
    const { source, broker } = setup();
    const quote = (await broker.getQuotes(instruments))[0]!;
    vi.spyOn(broker, 'getQuotes').mockResolvedValue([
      { ...quote, timestamp: null },
      (await broker.getQuotes(instruments))[1]!,
    ]);
    const result = (await source(instruments, signal())) as PaperEvidence[];
    expect(result[0]!.quote.timestamp).toBeNull();
    expect(prepare(result[0]!).blockers).toContain('QUOTE_TIME_MISSING');
  });

  it('휴장과 오래된 시세를 숨기거나 거래 가능한 세션으로 바꾸지 않는다', async () => {
    const { source, broker } = setup();
    const quote = (await broker.getQuotes(instruments))[0]!;
    vi.spyOn(broker, 'getQuotes').mockResolvedValue([
      { ...quote, timestamp: '2026-03-25T00:00:00Z' },
      (await broker.getQuotes(instruments))[1]!,
    ]);
    const calendar = await broker.getMarketCalendar('KR');
    const us = await broker.getMarketCalendar('US');
    vi.spyOn(broker, 'getMarketCalendar').mockImplementation(async (market) =>
      market === 'KR' ? { ...calendar, today: { ...calendar.today, sessions: [] } } : us,
    );
    const result = (await source(instruments, signal())) as PaperEvidence[];
    expect(prepare(result[0]!).blockers).toEqual(expect.arrayContaining(['MARKET_CLOSED', 'QUOTE_STALE']));
  });

  it('응답 종목 누락/중복을 거부하고 부분 결과를 반환하지 않는다', async () => {
    const { source, broker } = setup();
    const quotes = await broker.getQuotes(instruments);
    vi.spyOn(broker, 'getQuotes').mockResolvedValue([quotes[0]!, quotes[0]!]);
    const candles = vi.spyOn(broker, 'getCandles');
    await expect(source(instruments, signal())).rejects.toThrow('PAPER_SOURCE_INSTRUMENT_MISMATCH');
    expect(candles).not.toHaveBeenCalled();
  });

  it('잘못된 통화와 캘린더 시장을 거부한다', async () => {
    const { source, broker } = setup();
    const quotes = await broker.getQuotes(instruments);
    vi.spyOn(broker, 'getQuotes').mockResolvedValue([{ ...quotes[0]!, currency: 'USD' }, quotes[1]!]);
    await expect(source(instruments, signal())).rejects.toThrow('PAPER_SOURCE_CURRENCY_MISMATCH');
    vi.spyOn(broker, 'getMarketCalendar').mockResolvedValue(await createHarness().broker.getMarketCalendar('US'));
    await expect(source(instruments, signal())).rejects.toThrow('PAPER_SOURCE_CALENDAR_MISMATCH');
  });

  it('조회 실패를 성공 evidence로 반환하지 않는다', async () => {
    const { source, broker } = setup();
    vi.spyOn(broker, 'getQuotes').mockRejectedValue(new Error('fixture failure'));
    await expect(source(instruments, signal())).rejects.toThrow('fixture failure');
  });

  it('진행 중인 수집과 중첩하지 않으며 완료 후 다음 수집을 허용한다', async () => {
    const { source, broker } = setup();
    const metadata = await broker.getInstruments(instruments);
    let complete!: (value: typeof metadata) => void;
    const pending = new Promise<typeof metadata>((resolve) => {
      complete = resolve;
    });
    vi.spyOn(broker, 'getInstruments').mockReturnValueOnce(pending);
    const first = source(instruments, signal());
    await expect(source(instruments, signal())).rejects.toThrow('PAPER_MARKET_SOURCE_BUSY');
    complete(metadata);
    await expect(first).resolves.toHaveLength(2);
    await expect(source(instruments, signal())).resolves.toHaveLength(2);
  });

  it('취소 뒤에는 후속 조회를 하지 않고 진행 중 응답을 폐기한다', async () => {
    const { source, broker } = setup();
    const controller = new AbortController();
    const quotes = await broker.getQuotes(instruments);
    vi.spyOn(broker, 'getQuotes').mockImplementation(async () => {
      controller.abort();
      return quotes;
    });
    const calendar = vi.spyOn(broker, 'getMarketCalendar');
    await expect(source(instruments, controller.signal)).rejects.toThrow();
    expect(calendar).not.toHaveBeenCalled();
    const metadata = vi.spyOn(broker, 'getInstruments');
    await expect(source(instruments, AbortSignal.abort())).rejects.toThrow();
    expect(metadata).not.toHaveBeenCalled();
  });

  it('잘못된 요청과 페이지 상한을 실제 조회 전에 거부한다', async () => {
    const { source, broker } = setup();
    const metadata = vi.spyOn(broker, 'getInstruments');
    await expect(source([instruments[0], instruments[0]], signal())).rejects.toThrow(
      'PAPER_SOURCE_INSTRUMENT_MISMATCH',
    );
    await expect(source([], signal())).rejects.toThrow();
    expect(() => createPaperMarketSource(broker, 6)).toThrow('INVALID_PAGE_LIMIT');
    expect(metadata).not.toHaveBeenCalled();
  });
});

// Synthetic normalized broker data, not historical quotes or an API recording.
function usOpeningFixture(elapsedMinutes: number) {
  const instrument = instruments[1];
  const opening = Date.parse('2026-11-04T14:30:00Z');
  const observed = opening + elapsedMinutes * 60_000;
  const observedAt = new Date(observed).toISOString();
  const candles: Candle[] = Array.from({ length: elapsedMinutes }, (_, index) => ({
    instrument,
    interval: '1m',
    timestamp: new Date(opening + (index + 1) * 60_000).toISOString(),
    tradingDate: '2026-11-04',
    open: '100',
    high: '100',
    low: '100',
    close: '100',
    volume: '10',
    currency: 'USD',
    adjusted: false,
    source: 'toss',
    isClosed: false,
  }));
  const day = (date: string) => ({
    market: 'US' as const,
    tradingDate: date,
    sessionsKnown: true,
    sessions: [{ type: 'regular' as const, startsAt: `${date}T14:30:00Z`, endsAt: `${date}T21:00:00Z` }],
  });
  const calendar: MarketCalendar = {
    today: day('2026-11-04'),
    previousBusinessDay: day('2026-11-03'),
    nextBusinessDay: day('2026-11-05'),
  };
  const broker = {
    getInstruments: vi
      .fn()
      .mockResolvedValue([{ id: instrument, currency: 'USD', status: 'ACTIVE', nxtSupported: null }]),
    getQuotes: vi.fn().mockResolvedValue([{ instrument, currency: 'USD', price: '100', timestamp: observedAt }]),
    getMarketCalendar: vi.fn().mockResolvedValue(calendar),
    getExchangeRate: vi.fn().mockResolvedValue({
      baseCurrency: 'USD',
      quoteCurrency: 'KRW',
      validFrom: '2026-11-04T00:00:00Z',
      validUntil: '2026-11-05T00:00:00Z',
    }),
    getCandles: vi.fn().mockResolvedValue({ candles, nextBefore: null }),
  } satisfies Parameters<typeof createPaperMarketSource>[0];
  const prepareAt = (entry: PaperEvidence, asOf = observedAt) =>
    prepareStrategyData({
      ...entry.marketData,
      instrument,
      quoteTimestamp: asOf,
      quoteObservedAt: asOf,
      accountAvailable: true,
      accountObservedAt: asOf,
      asOf,
    });
  return { instrument, opening, observed, observedAt, candles, broker, prepareAt };
}

describe('미국 현재 정규장 분봉 warm-up (합성 fixture)', () => {
  it.each([
    [5, 4, 'WARMUP'],
    [21, 20, 'WARMUP'],
    [22, 21, 'NO_CROSS'],
    [25, 24, 'NO_CROSS'],
  ])('개장 %i분: 종료 후 60초 재관측한 %i개만 전략에 전달한다', async (minutes, closed, reason) => {
    const fixture = usOpeningFixture(minutes);
    const source = createPaperMarketSource(fixture.broker, 1, () => fixture.observed);
    const [entry] = (await source([fixture.instrument], signal())) as PaperEvidence[];
    expect(fixture.broker.getCandles).toHaveBeenCalledExactlyOnceWith({
      instrument: fixture.instrument,
      interval: '1m',
      count: 200,
      adjusted: false,
    });
    expect(entry!.marketData.candles).toEqual(fixture.candles);
    expect(entry!.marketData.candles.every((candle) => !candle.isClosed)).toBe(true);
    const prepared = fixture.prepareAt(entry!);
    expect(prepared.ready).toBe(true);
    expect(prepared.blockers).toEqual([]);
    expect(prepared.candles).toHaveLength(closed);
    expect(prepared.candles.every((candle) => candle.isClosed)).toBe(true);
    expect(prepared.assessments.at(-1)).toMatchObject({ status: 'pending', reason: 'BAR_NOT_SETTLED' });
    expect(
      prepared.candles.every(
        (candle) => Date.parse(candle.timestamp) - 60_000 >= fixture.opening && candle.tradingDate === '2026-11-04',
      ),
    ).toBe(true);
    expect(
      movingAverageCross.evaluate(
        {
          instrument: fixture.instrument,
          evaluatedAt: fixture.observedAt,
          closedCandles: prepared.candles,
          ownedQuantity: '0',
        },
        { fastPeriod: 5, slowPeriod: 20 },
      ),
    ).toEqual({ action: 'HOLD', reason });
    // Policy assessment must not mutate raw source evidence.
    expect(entry!.marketData.candles.every((candle) => !candle.isClosed)).toBe(true);
  });

  it('일찍 관측한 봉을 시간이 지났다는 이유로 승격하지 않고 60초 뒤 새 source 수집이 필요하다', async () => {
    const fixture = usOpeningFixture(21);
    let observed = fixture.observed;
    const source = createPaperMarketSource(fixture.broker, 1, () => observed);
    const [early] = (await source([fixture.instrument], signal())) as PaperEvidence[];
    observed += 60_000;
    const later = new Date(observed).toISOString();
    const unreobserved = fixture.prepareAt(early!, later);
    expect(unreobserved.candles).toHaveLength(20);
    expect(unreobserved.assessments.at(-1)).toMatchObject({ status: 'pending', reason: 'BAR_NOT_REOBSERVED' });
    const [fresh] = (await source([fixture.instrument], signal())) as PaperEvidence[];
    expect(fixture.prepareAt(fresh!, later).candles).toHaveLength(21);
    expect(fixture.broker.getCandles).toHaveBeenCalledTimes(2);
    expect(fresh!.marketData.candles.every((candle) => !candle.isClosed)).toBe(true);
  });

  it('명시적 두 페이지 수집도 25분 입력을 잘라내거나 경계 봉을 확정하지 않는다', async () => {
    const fixture = usOpeningFixture(25);
    const boundary = fixture.candles[12]!;
    fixture.broker.getCandles
      .mockResolvedValueOnce({ candles: fixture.candles.slice(12).toReversed(), nextBefore: boundary.timestamp })
      .mockResolvedValueOnce({ candles: fixture.candles.slice(0, 13).toReversed(), nextBefore: null });
    const source = createPaperMarketSource(fixture.broker, 2, () => fixture.observed);
    const [entry] = (await source([fixture.instrument], signal())) as PaperEvidence[];
    expect(fixture.broker.getCandles).toHaveBeenCalledTimes(2);
    expect(fixture.broker.getCandles).toHaveBeenNthCalledWith(2, {
      instrument: fixture.instrument,
      interval: '1m',
      count: 200,
      adjusted: false,
      before: boundary.timestamp,
    });
    expect(entry!.marketData.candles).toEqual(fixture.candles);
    expect(fixture.prepareAt(entry!).candles).toHaveLength(24);
    expect(entry!.marketData.candles.every((candle) => !candle.isClosed)).toBe(true);
  });

  it('개장 25분이어도 제공되지 않은 분봉을 채워 warm-up을 통과시키지 않는다', async () => {
    const fixture = usOpeningFixture(25);
    fixture.broker.getCandles.mockResolvedValue({ candles: fixture.candles.slice(4), nextBefore: null });
    const source = createPaperMarketSource(fixture.broker, 1, () => fixture.observed);
    const [entry] = (await source([fixture.instrument], signal())) as PaperEvidence[];
    expect(entry!.marketData.candles).toHaveLength(21);
    const prepared = fixture.prepareAt(entry!);
    expect(prepared.ready).toBe(true);
    expect(prepared.candles).toHaveLength(20);
    expect(
      movingAverageCross.evaluate(
        {
          instrument: fixture.instrument,
          evaluatedAt: fixture.observedAt,
          closedCandles: prepared.candles,
          ownedQuantity: '0',
        },
        { fastPeriod: 5, slowPeriod: 20 },
      ),
    ).toEqual({ action: 'HOLD', reason: 'WARMUP' });
    expect(fixture.broker.getCandles).toHaveBeenCalledTimes(1);
  });
});
