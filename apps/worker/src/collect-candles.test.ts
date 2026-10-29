import { expect, it, vi } from 'vitest';
import { createHarness } from '../../../packages/broker/test/harness.js';
import { collectCandles } from './collect-candles.js';

const instrument = { market: 'KR', symbol: '005930' } as const;
it('inclusive 경계의 같은 시각은 첫 관측 값을 보존하고 종료 플래그를 재사용하지 않는다', async () => {
  const { broker } = createHarness();
  const page = await broker.getCandles({ instrument, interval: '1m', count: 200, adjusted: false });
  const candle = { ...page.candles[0]!, isClosed: true };
  vi.spyOn(broker, 'getCandles')
    .mockResolvedValueOnce({ candles: [candle], nextBefore: candle.timestamp })
    .mockResolvedValueOnce({
      candles: [{ ...candle, timestamp: new Date(candle.timestamp).toISOString(), close: '1' }],
      nextBefore: null,
    });
  const candles = await collectCandles(broker, instrument, '1m', 2);
  expect(candles).toHaveLength(1);
  expect(candles[0]).toMatchObject({ close: candle.close, isClosed: false });
});
it('다른 종목/통화의 봉을 섞지 않는다', async () => {
  const { broker } = createHarness();
  const page = await broker.getCandles({ instrument, interval: '1m', count: 200, adjusted: false });
  vi.spyOn(broker, 'getCandles').mockResolvedValue({ ...page, candles: [{ ...page.candles[0]!, currency: 'USD' }] });
  await expect(collectCandles(broker, instrument, '1m', 2)).rejects.toThrow('CANDLE_INSTRUMENT_MISMATCH');
});
it('페이지 조회 중 취소되면 다음 페이지를 요청하지 않는다', async () => {
  const { broker } = createHarness();
  const page = await broker.getCandles({ instrument, interval: '1m', count: 200, adjusted: false });
  const controller = new AbortController();
  const read = vi.spyOn(broker, 'getCandles').mockImplementation(async () => {
    controller.abort();
    return page;
  });
  await expect(collectCandles(broker, instrument, '1m', 5, controller.signal)).rejects.toThrow();
  expect(read).toHaveBeenCalledTimes(1);
});
