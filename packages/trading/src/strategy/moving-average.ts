import { movingAverageConfigSchema } from '@hth/contracts';
import type { MovingAverageConfig } from '@hth/contracts';
import type { Strategy } from './types.js';

function scaled(value: string, scale: number) {
  const [whole = '', fraction = ''] = value.split('.');
  return BigInt(whole + fraction.padEnd(scale, '0'));
}

export const movingAverageCross: Strategy<MovingAverageConfig> = {
  id: 'moving-average-cross',
  version: '1.0.0',
  evaluate(context, input) {
    const parsed = movingAverageConfigSchema.safeParse(input);
    if (!parsed.success) throw new Error('INVALID_STRATEGY_CONFIG');
    const { fastPeriod, slowPeriod } = parsed.data;
    if (context.closedCandles.length < slowPeriod + 1) return { action: 'HOLD', reason: 'WARMUP' };
    const candles = context.closedCandles.slice(-(slowPeriod + 1));
    if (
      candles.some(
        (candle) =>
          !candle.isClosed ||
          candle.instrument.market !== context.instrument.market ||
          candle.instrument.symbol !== context.instrument.symbol ||
          !/^\d+(\.\d+)?$/.test(candle.close) ||
          candle.close.length > 30,
      )
    )
      throw new Error('INVALID_STRATEGY_DATA');
    const scale = Math.max(...candles.map((candle) => candle.close.split('.')[1]?.length ?? 0));
    const prices = candles.map((candle) => scaled(candle.close, scale));
    const difference = (end: number) =>
      prices.slice(end - fastPeriod, end).reduce((sum, price) => sum + price, 0n) * BigInt(slowPeriod) -
      prices.slice(end - slowPeriod, end).reduce((sum, price) => sum + price, 0n) * BigInt(fastPeriod);
    const previous = difference(prices.length - 1);
    const current = difference(prices.length);
    if (previous <= 0n && current > 0n) return { action: 'BUY', reason: 'BULLISH_CROSS' };
    if (previous >= 0n && current < 0n) return { action: 'SELL', reason: 'BEARISH_CROSS' };
    return { action: 'HOLD', reason: 'NO_CROSS' };
  },
};
