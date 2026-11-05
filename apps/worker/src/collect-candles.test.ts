import { expect, it, vi } from 'vitest';
import { createHarness } from '../../../packages/broker/test/harness.js';
import type { Candle } from '@hth/contracts';
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

const usInstrument = { market: 'US', symbol: 'AAPL' } as const;
function openingCandles(minutes: number): Candle[] {
  const opening = Date.parse('2026-11-04T14:30:00Z');
  return Array.from({ length: minutes }, (_, index) => ({
    instrument: usInstrument,
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
    // Deliberately untrusted: collector must clear even this input flag.
    isClosed: true,
  }));
}

it.each([5, 25])('미국 개장 %i분 입력을 count=200 한 번으로 모두 보존한다', async (minutes) => {
  const input = openingCandles(minutes);
  const read = vi.fn().mockResolvedValue({ candles: input.toReversed(), nextBefore: null });
  const result = await collectCandles({ getCandles: read }, usInstrument, '1m', 1);
  expect(read).toHaveBeenCalledExactlyOnceWith({
    instrument: usInstrument,
    interval: '1m',
    count: 200,
    adjusted: false,
  });
  expect(result).toEqual(input.map((candle) => ({ ...candle, isClosed: false })));
  expect(input.every((candle) => candle.isClosed)).toBe(true);
});

it('페이지 상한 1은 명시된 nextBefore를 추적하지 않으며 상한 2는 두 페이지 25개를 합친다', async () => {
  const input = openingCandles(25);
  const boundary = input[12]!;
  const firstPage = { candles: input.slice(12).toReversed(), nextBefore: boundary.timestamp };
  const secondPage = { candles: input.slice(0, 13).toReversed(), nextBefore: null };
  const capped = vi.fn().mockResolvedValue(firstPage);
  const limited = await collectCandles({ getCandles: capped }, usInstrument, '1m', 1);
  expect(capped).toHaveBeenCalledTimes(1);
  expect(limited).toHaveLength(13);
  const paginated = vi.fn().mockResolvedValueOnce(firstPage).mockResolvedValueOnce(secondPage);
  const complete = await collectCandles({ getCandles: paginated }, usInstrument, '1m', 2);
  expect(paginated).toHaveBeenCalledTimes(2);
  expect(paginated).toHaveBeenNthCalledWith(2, {
    instrument: usInstrument,
    interval: '1m',
    count: 200,
    adjusted: false,
    before: boundary.timestamp,
  });
  expect(complete).toEqual(input.map((candle) => ({ ...candle, isClosed: false })));
});

it('빈 종단 페이지는 추가 재시도 없이 끝나고 반복 cursor는 실패한다', async () => {
  const input = openingCandles(5);
  const before = input[0]!.timestamp;
  const empty = vi
    .fn()
    .mockResolvedValueOnce({ candles: input, nextBefore: before })
    .mockResolvedValueOnce({ candles: [], nextBefore: before });
  expect(await collectCandles({ getCandles: empty }, usInstrument, '1m', 5)).toHaveLength(5);
  expect(empty).toHaveBeenCalledTimes(2);
  const repeated = vi.fn().mockResolvedValue({ candles: input, nextBefore: before });
  await expect(collectCandles({ getCandles: repeated }, usInstrument, '1m', 5)).rejects.toThrow(
    'CANDLE_CURSOR_NOT_ADVANCING',
  );
  expect(repeated).toHaveBeenCalledTimes(2);
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
