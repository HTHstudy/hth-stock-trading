import { afterEach, expect, it, vi } from 'vitest';
import type { PaperEvidence } from '@hth/contracts';
import { movingAverageCross, prepareStrategyData } from '@hth/trading';
import { createPaperSyntheticSource } from './paper-synthetic-source.js';

afterEach(() => {
  vi.useRealTimers();
});
it('저장된 장기 기간에 필요한 합성 봉을 제공하고 미래 봉을 넣지 않는다', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-03-25T01:05:00Z'));
  const [evidence] = (await createPaperSyntheticSource(21)(
    [{ market: 'KR', symbol: '005930' }],
    new AbortController().signal,
  )) as PaperEvidence[];
  const prepared = prepareStrategyData({
    ...evidence!.marketData,
    instrument: evidence!.quote.instrument,
    quoteTimestamp: evidence!.quote.timestamp,
    quoteObservedAt: evidence!.quote.observedAt,
    accountObservedAt: evidence!.quote.observedAt,
    accountAvailable: true,
    asOf: evidence!.quote.observedAt,
  });
  expect(prepared.ready).toBe(true);
  expect(prepared.candles).toHaveLength(21);
  expect(
    movingAverageCross.evaluate(
      {
        instrument: evidence!.quote.instrument,
        evaluatedAt: evidence!.quote.observedAt,
        closedCandles: prepared.candles,
        ownedQuantity: '0',
      },
      { fastPeriod: 5, slowPeriod: 20 },
    ).reason,
  ).not.toBe('WARMUP');
});
it('lookback이 달라도 겹치는 과거 봉의 가격과 시각은 같다', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-03-25T01:05:00Z'));
  const instrument = { market: 'KR', symbol: '005930' } as const;
  const [short] = (await createPaperSyntheticSource(3)([instrument], new AbortController().signal)) as PaperEvidence[];
  const [long] = (await createPaperSyntheticSource(21)([instrument], new AbortController().signal)) as PaperEvidence[];
  expect(long!.marketData.candles.slice(-3)).toEqual(short!.marketData.candles);
});
it('잘못된 lookback과 취소 요청을 거부한다', async () => {
  expect(() => createPaperSyntheticSource(2)).toThrow('PAPER_DEMO_LOOKBACK_INVALID');
  expect(() => createPaperSyntheticSource(2002)).toThrow('PAPER_DEMO_LOOKBACK_INVALID');
  await expect(createPaperSyntheticSource()([], AbortSignal.abort())).rejects.toThrow();
});
