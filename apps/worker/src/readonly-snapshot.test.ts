import { describe, expect, it, vi } from 'vitest';
import { createHarness } from '../../../packages/broker/test/harness.js';
import { collectReadonlySnapshot } from './readonly-snapshot.js';
import { parseReadonlyConfig } from './readonly-config.js';

const instruments = [
  { market: 'KR', symbol: '005930' },
  { market: 'US', symbol: 'AAPL' },
] as const;

describe('읽기 전용 snapshot', () => {
  it('조회 시각을 주입해 봉 종료와 종목별 차단 사유를 함께 기록한다', async () => {
    const { broker } = createHarness();
    vi.spyOn(broker, 'getQuotes').mockResolvedValue(
      instruments.map((instrument) => ({
        instrument,
        currency: instrument.market === 'KR' ? 'KRW' : 'USD',
        price: '72000',
        timestamp: '2026-03-25T00:32:50Z',
      })),
    );
    const exchangeRate = await broker.getExchangeRate('USD', 'KRW');
    vi.spyOn(broker, 'getExchangeRate').mockResolvedValue({
      ...exchangeRate,
      validFrom: '2026-03-25T00:32:00Z',
      validUntil: '2026-03-25T00:34:00Z',
    });
    const snapshot = await collectReadonlySnapshot(broker, instruments, '1m', 1, () =>
      Date.parse('2026-03-25T00:33:00Z'),
    );
    expect(snapshot.dataQuality.readyCount).toBe(1);
    expect(snapshot.dataQuality.instruments[0]).toMatchObject({
      ready: true,
      closedCandles: 2,
      strategyCandles: 2,
      validUntil: '2026-03-25T00:34:00.000Z',
    });
    expect(snapshot.dataQuality.instruments[1]?.blockers).toContain('MARKET_CLOSED');
    expect(snapshot.batches[0]?.candles.every((candle) => candle.isClosed)).toBe(true);
    expect(snapshot.batches[1]?.candles.every((candle) => !candle.isClosed)).toBe(true);
  });

  it('전체 조회를 실행하고 로그용 요약에 계좌·금액을 노출하지 않는다', async () => {
    const { broker, fetcher } = createHarness();
    const snapshot = await collectReadonlySnapshot(broker, instruments, '1m', 1);
    expect(snapshot.batches).toHaveLength(2);
    expect(snapshot.summary).toMatchObject({ accounts: 1, holdings: 2, candles: 4, executionEnabled: false });
    expect(JSON.stringify(snapshot.summary)).not.toMatch(/accountNo|reference|cashBuyingPower|72000/);
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith('/oauth2/token'))).toHaveLength(1);
  });

  it('inclusive 페이지의 중복 캔들을 제거한다', async () => {
    const { broker } = createHarness();
    const original = await broker.getCandles({
      instrument: instruments[0],
      interval: '1m',
      count: 200,
      adjusted: false,
    });
    const first = original.candles[0]!;
    vi.spyOn(broker, 'getCandles')
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce({ candles: [first], nextBefore: null })
      .mockResolvedValueOnce({ candles: [], nextBefore: null });
    const snapshot = await collectReadonlySnapshot(broker, instruments, '1m', 2);
    expect(snapshot.batches[0]?.candles).toHaveLength(2);
  });

  it('페이지 cursor가 전진하지 않으면 실패하고 무한 반복하지 않는다', async () => {
    const { broker } = createHarness();
    const result = await broker.getCandles({ instrument: instruments[0], interval: '1m', count: 200, adjusted: false });
    const repeated = { ...result, candles: result.candles.slice(0, 1) };
    vi.spyOn(broker, 'getCandles').mockResolvedValueOnce(result).mockResolvedValueOnce(repeated);
    await expect(collectReadonlySnapshot(broker, instruments, '1m', 3)).rejects.toThrow('CANDLE_CURSOR_NOT_ADVANCING');
  });

  it('조회 실패 시 불완전한 snapshot을 반환하지 않는다', async () => {
    const { broker } = createHarness();
    vi.spyOn(broker, 'getQuotes').mockRejectedValue(new Error('test failure'));
    const candles = vi.spyOn(broker, 'getCandles');
    await expect(collectReadonlySnapshot(broker, instruments, '1m', 1)).rejects.toThrow('test failure');
    expect(candles).not.toHaveBeenCalled();
  });

  it('명시적인 설정이 없거나 live이면 실제 연결 준비를 거부한다', () => {
    expect(() => parseReadonlyConfig({})).toThrow('READONLY_CONFIGURATION_INVALID');
    const config = {
      TOSS_CLIENT_ID: 'fixture',
      TOSS_CLIENT_SECRET: 'fixture',
      DATABASE_URL: 'postgresql://localhost/test',
    };
    expect(parseReadonlyConfig(config).TRADING_MODE).toBe('paper');
    expect(() => parseReadonlyConfig({ ...config, TRADING_MODE: 'live' })).toThrow();
    expect(() => parseReadonlyConfig({ ...config, READONLY_SYMBOLS: 'US:AAPL,US:aapl' })).toThrow();
    expect(() => parseReadonlyConfig({ ...config, DATABASE_URL: 'https://invalid.local' })).toThrow();
  });
});
