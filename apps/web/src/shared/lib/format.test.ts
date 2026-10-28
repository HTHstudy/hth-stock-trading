import { describe, expect, it } from 'vitest';
import { formatDecimal, formatMoney, profitClass } from './format.js';

describe('화면 숫자 표시', () => {
  it('큰 정수를 number로 변환하지 않고 표시한다', () => {
    expect(formatDecimal('9007199254740993.125')).toBe('9,007,199,254,740,993.13');
    expect(formatMoney('1234.56', 'KRW')).toBe('₩1,235');
    expect(formatDecimal('-0.005', 2, true)).toBe('−0.01');
    expect(formatDecimal('0.0001', 2, true)).toBe('0.00');
    expect(formatDecimal(undefined)).toBe('—');
  });
  it('손익 부호를 문자열에서 판정한다', () => {
    expect(profitClass('-0.01')).toBe('text-sky-400');
    expect(profitClass('0.000')).toBe('text-slate-400');
  });
});
