import { buyAndHoldConfigSchema, instantSchema } from '@hth/contracts';
import type { BuyAndHoldConfig } from '@hth/contracts';
import { Decimal } from 'decimal.js';
import type { Strategy } from './types.js';

const Money = Decimal.clone({ precision: 100 });
const amount = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 30 && /^\d+(\.\d+)?$/.test(value);

// Research benchmark only. A missed entry is never retried on a later candle.
export const buyAndHold: Strategy<BuyAndHoldConfig> = {
  id: 'buy-and-hold',
  version: '1.0.0',
  evaluate(context, input) {
    const parsed = buyAndHoldConfigSchema.safeParse(input);
    if (!parsed.success) throw new Error('INVALID_STRATEGY_CONFIG');
    if (!amount(context.ownedQuantity) || !instantSchema.safeParse(context.evaluatedAt).success)
      throw new Error('INVALID_STRATEGY_DATA');
    const { entryAfterClosedCandles: count } = parsed.data;
    const candles = context.closedCandles.slice(-count);
    let previous = -Infinity;
    for (const candle of candles) {
      if (
        candle.isClosed !== true ||
        candle.instrument.market !== context.instrument.market ||
        candle.instrument.symbol !== context.instrument.symbol ||
        ![candle.open, candle.high, candle.low, candle.close].every(amount) ||
        !instantSchema.safeParse(candle.timestamp).success
      )
        throw new Error('INVALID_STRATEGY_DATA');
      const timestamp = Date.parse(candle.timestamp);
      const [open, high, low, close] = [candle.open, candle.high, candle.low, candle.close].map(
        (value) => new Money(value),
      ) as [Decimal, Decimal, Decimal, Decimal];
      if (
        timestamp <= previous ||
        timestamp > Date.parse(context.evaluatedAt) ||
        low.lte(0) ||
        high.lt(low) ||
        open.lt(low) ||
        open.gt(high) ||
        close.lt(low) ||
        close.gt(high)
      )
        throw new Error('INVALID_STRATEGY_DATA');
      previous = timestamp;
    }
    if (context.closedCandles.length < count) return { action: 'HOLD', reason: 'WARMUP' };
    if (context.closedCandles.length === count && new Money(context.ownedQuantity).isZero())
      return { action: 'BUY', reason: 'BENCHMARK_ENTRY' };
    return { action: 'HOLD', reason: 'BENCHMARK_HOLD' };
  },
};
