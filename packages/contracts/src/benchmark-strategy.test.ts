import { expect, it } from 'vitest';
import { buyAndHoldConfigSchema } from './benchmark-strategy.js';

it('진입 봉 수는 1~2001 정수이고 추가 필드를 거부한다', () => {
  for (const entryAfterClosedCandles of [1, 21, 2001])
    expect(buyAndHoldConfigSchema.parse({ entryAfterClosedCandles })).toEqual({ entryAfterClosedCandles });
  for (const entryAfterClosedCandles of [0, 2002, 1.5, '21', NaN, Infinity])
    expect(buyAndHoldConfigSchema.safeParse({ entryAfterClosedCandles }).success).toBe(false);
  expect(buyAndHoldConfigSchema.safeParse({}).success).toBe(false);
  expect(buyAndHoldConfigSchema.safeParse({ entryAfterClosedCandles: 1, resume: true }).success).toBe(false);
});
