import { describe, expect, it } from 'vitest';
import { decimalSchema, paperModeSchema } from './index.js';

describe('안전한 공통 계약', () => {
  it('기본 모드는 paper이고 live나 알 수 없는 값은 거부한다', () => {
    expect(paperModeSchema.parse(undefined)).toBe('paper');
    for (const mode of ['live', 'LIVE', '', 'production']) {
      expect(paperModeSchema.safeParse(mode).success).toBe(false);
    }
  });

  it('정밀 금액을 문자열로 유지하고 number와 지수 표기를 거부한다', () => {
    expect(decimalSchema.parse('12345678901234567890.1234567890')).toBe('12345678901234567890.1234567890');
    expect(decimalSchema.safeParse(0.1).success).toBe(false);
    expect(decimalSchema.safeParse('1e10').success).toBe(false);
  });
});
