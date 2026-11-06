import { channelBreakoutConfigSchema, instantSchema } from '@hth/contracts';
import type { ChannelBreakoutConfig } from '@hth/contracts';
import { Decimal } from 'decimal.js';
import type { Strategy } from './types.js';

const Money = Decimal.clone({ precision: 100 });
const amount = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 30 && /^\d+(\.\d+)?$/.test(value);

// Research only: this plugin emits direction; the engine owns order sizing.
export const channelBreakout: Strategy<ChannelBreakoutConfig> = {
  id: 'channel-breakout',
  version: '1.0.0',
  evaluate(context, input) {
    const parsed = channelBreakoutConfigSchema.safeParse(input);
    if (!parsed.success) throw new Error('INVALID_STRATEGY_CONFIG');
    const config = parsed.data;
    if (!amount(context.ownedQuantity)) throw new Error('INVALID_STRATEGY_DATA');
    const owned = new Money(context.ownedQuantity);
    const period = Math.max(config.entryPeriod, config.exitPeriod);
    const candles = context.closedCandles.slice(-(period + 1));
    let previousTimestamp = -Infinity;
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
      const open = new Money(candle.open);
      const high = new Money(candle.high);
      const low = new Money(candle.low);
      const close = new Money(candle.close);
      if (
        timestamp <= previousTimestamp ||
        low.lte('0') ||
        high.lt(low) ||
        open.lt(low) ||
        open.gt(high) ||
        close.lt(low) ||
        close.gt(high)
      )
        throw new Error('INVALID_STRATEGY_DATA');
      previousTimestamp = timestamp;
    }
    if (candles.length < period + 1) return { action: 'HOLD', reason: 'WARMUP' };
    const previous = candles.slice(0, -1);
    const close = new Money(candles.at(-1)!.close);
    const entryHigh = Money.max(...previous.slice(-config.entryPeriod).map((candle) => candle.high));
    const exitLow = Money.min(...previous.slice(-config.exitPeriod).map((candle) => candle.low));
    if (owned.isZero() && close.gt(entryHigh)) return { action: 'BUY', reason: 'CHANNEL_BREAKOUT' };
    if (owned.gt('0') && close.lt(exitLow)) return { action: 'SELL', reason: 'CHANNEL_EXIT' };
    return { action: 'HOLD', reason: 'NO_CHANNEL_SIGNAL' };
  },
};
