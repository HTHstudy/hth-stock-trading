import { expect, it } from 'vitest';
import type { Candle } from '@hth/contracts';
import { canonicalJson, contentHash, candleRevision } from './content-hash.js';

it('객체 키 순서에 무관하고 배열 순서에는 민감한 SHA-256을 만든다', () => {
  expect(contentHash({ price: '1', nested: { b: 2, a: 1 } })).toBe(contentHash({ nested: { a: 1, b: 2 }, price: '1' }));
  expect(contentHash([1, 2])).not.toBe(contentHash([2, 1]));
  for (const value of [undefined, NaN, Infinity, new Date()])
    expect(() => canonicalJson(value)).toThrow('INVALID_CANONICAL_VALUE');
});

it('십진 표기와 종료 플래그 대신 실제 시세 변경으로 revision을 식별한다', () => {
  const candle: Candle = {
    instrument: { market: 'US', symbol: 'AAPL' },
    interval: '1d',
    timestamp: '2026-03-25T00:00:00-04:00',
    tradingDate: '2026-03-25',
    open: '001.00',
    high: '2',
    low: '1',
    close: '1.0',
    volume: '10',
    currency: 'USD',
    adjusted: false,
    source: 'toss',
    isClosed: false,
  };
  expect(candleRevision(candle).valueHash).toBe(
    candleRevision({ ...candle, open: '1', close: '1', isClosed: true }).valueHash,
  );
  expect(candleRevision(candle).valueHash).not.toBe(candleRevision({ ...candle, close: '2' }).valueHash);
});
