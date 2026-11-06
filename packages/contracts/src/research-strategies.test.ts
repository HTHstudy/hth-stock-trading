import { expect, it } from 'vitest';
import { channelBreakoutConfigSchema, meanReversionConfigSchema } from './research-strategies.js';

it('채널 기간은 정수 2..2000이며 청산 기간은 진입 기간 이하다', () => {
  for (const period of [2, 2000]) {
    expect(channelBreakoutConfigSchema.safeParse({ entryPeriod: period, exitPeriod: period }).success).toBe(true);
  }
  for (const period of [1, 2001, 2.5, NaN, Infinity, '2', null]) {
    expect(channelBreakoutConfigSchema.safeParse({ entryPeriod: period, exitPeriod: 2 }).success).toBe(false);
    expect(channelBreakoutConfigSchema.safeParse({ entryPeriod: 2000, exitPeriod: period }).success).toBe(false);
    expect(meanReversionConfigSchema.safeParse({ period, entryDeviationBps: '1' }).success).toBe(false);
  }
  expect(channelBreakoutConfigSchema.safeParse({ entryPeriod: 2, exitPeriod: 3 }).success).toBe(false);
  expect(channelBreakoutConfigSchema.safeParse({ entryPeriod: 2, exitPeriod: 2, extra: true }).success).toBe(false);
});

it('편차는 30자 이하의 양수 십진 문자열이며 10000 경계를 정확하게 비교한다', () => {
  for (const entryDeviationBps of [
    '1',
    '0001.00',
    '0.0000000000000000000000000001',
    '9999.9999999999999999999999999',
  ]) {
    for (const period of [2, 2000])
      expect(meanReversionConfigSchema.safeParse({ period, entryDeviationBps }).success).toBe(true);
  }
  for (const entryDeviationBps of [
    '0',
    '0.000',
    '-1',
    '10000',
    '10000.00000000000000000000001',
    '10001',
    '1e2',
    '.1',
    '1.',
    '+1',
    'NaN',
    'Infinity',
    '',
    ' 1',
    '1'.repeat(31),
    1,
    null,
  ]) {
    expect(meanReversionConfigSchema.safeParse({ period: 2, entryDeviationBps }).success).toBe(false);
  }
  expect(meanReversionConfigSchema.safeParse({ period: 2, entryDeviationBps: '1', extra: true }).success).toBe(false);
});
