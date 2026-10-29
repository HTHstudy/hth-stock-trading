import { expect, it } from 'vitest';
import { strategyComparison } from './strategy-comparison.js';

const definition = {
  kind: 'moving-average-cross',
  instrument: { market: 'KR', symbol: '005930' },
  parameters: { fastPeriod: 5, slowPeriod: 20 },
  quantity: '2',
  maxFillQuantity: '1',
} as const;
it('기록되지 않은 과거 조건을 기본 전략으로 추정하지 않는다', () => {
  const rows = strategyComparison(
    { version: '1.0.0', enabled: true, definition: null },
    { version: '1.0.0', enabled: true, definition },
  );
  expect(rows.find((item) => item.label === '단기 기간')).toMatchObject({
    before: '미등록',
    after: '5',
    changed: true,
  });
  expect(rows.find((item) => item.label === '주문 수량')).toMatchObject({ before: '미등록', after: '2' });
});
it('등록 활성과 조건의 차이만 강조하고 원본을 변경하지 않는다', () => {
  const before = { version: '1.0.0', enabled: false, definition };
  const current = { version: '1.0.0', enabled: true, definition: { ...definition, quantity: '3' } };
  const original = structuredClone(before);
  expect(
    strategyComparison(before, current)
      .filter((item) => item.changed)
      .map((item) => item.label),
  ).toEqual(['등록 활성', '주문 수량']);
  expect(before).toEqual(original);
});
