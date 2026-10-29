import { expect, it } from 'vitest';
import type { PaperEquityHistory } from '@hth/contracts';
import { equityChartPoints } from './equity-model.js';
function record(version: number, time: string, equity = '100'): PaperEquityHistory['points'][number] {
  return {
    point: {
      formatVersion: 'paper-equity-v1',
      version,
      source: 'synthetic-only',
      recordedAt: time,
      observedAt: time,
      reconciled: true,
      stale: false,
      values: [
        { currency: 'KRW', equity },
        { currency: 'USD', equity: '0' },
      ],
    },
    changePercent: [null, null],
  };
}
it('동일 초의 여러 평가는 마지막 버전 좌표만 사용하고 원본을 유지한다', () => {
  const points = [record(1, '2026-10-29T01:00:00.100Z'), record(2, '2026-10-29T01:00:00.900Z', '99')];
  expect(equityChartPoints(points, 0)).toEqual([{ time: Date.parse('2026-10-29T01:00:00Z') / 1000, value: 99 }]);
  expect(points).toHaveLength(2);
});
it('시각 퇴행과 숫자 범위 초과는 왜곡된 차트를 만들지 않는다', () => {
  expect(equityChartPoints([record(1, '2026-10-29T01:00:01Z'), record(2, '2026-10-29T01:00:00Z')], 0)).toBeNull();
  expect(equityChartPoints([record(1, '2026-10-29T01:00:00Z', '9'.repeat(400))], 0)).toBeNull();
});
