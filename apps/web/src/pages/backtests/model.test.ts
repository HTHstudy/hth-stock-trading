import { expect, it } from 'vitest';
import type { BacktestSummary } from '@hth/contracts';
import { chartPoints, comparisonBlocker, sourceLabel } from './model.js';

const report: BacktestSummary = {
  reportHash: 'a'.repeat(64),
  dataset: { id: null, contentHash: 'b'.repeat(64), source: 'file' },
  strategy: { id: 'moving-average-cross', version: '1.0.0', parameters: { fastPeriod: 2, slowPeriod: 3 } },
  config: {
    initialCash: '1000',
    quantity: '1',
    priceTick: '1',
    buyFeeBps: '0',
    sellFeeBps: '0',
    sellTaxBps: '0',
    slippageBps: '0',
  },
  currency: 'KRW',
  datasetRequest: {
    instrument: { market: 'KR', symbol: 'DEMO' },
    interval: '1d',
    adjusted: false,
    from: '2026-03-09',
    to: '2026-03-09',
    source: 'synthetic-demo-v1',
  },
  metrics: {
    initialCash: '1000',
    endingCash: '1000',
    endingQuantity: '0',
    endingEquity: '1000',
    netPnl: '0',
    realizedPnl: '0',
    unrealizedPnl: '0',
    cumulativeReturnPct: '0',
    maxDrawdownPct: '0',
    winRatePct: null,
    tradeCount: 0,
    fillCount: 0,
    totalFees: '0',
    totalTax: '0',
  },
};
it('데이터셋·통화·초기 자산이 다르면 곡선 겹치기를 차단한다', () => {
  expect(
    comparisonBlocker(report, { ...report, config: { ...report.config, initialCash: '1000.00', sellFeeBps: '10' } }),
  ).toBeNull();
  expect(comparisonBlocker(report, { ...report, currency: 'USD' })).toContain('통화');
  expect(
    comparisonBlocker(report, { ...report, dataset: { ...report.dataset, contentHash: 'c'.repeat(64) } }),
  ).toContain('데이터셋');
  expect(comparisonBlocker(report, { ...report, config: { ...report.config, initialCash: '2000' } })).toContain(
    '초기 자산',
  );
  expect(sourceLabel(report)).toBe('합성 데모');
});
it('같은 시각의 최종 평가값을 쓰고 표시 불가능한 숫자를 차트에 넘기지 않는다', () => {
  const point = {
    timestamp: '2026-03-09T00:00:00Z',
    kind: 'initial' as const,
    equity: '1000',
    cash: '1000',
    quantity: '0',
    cumulativeReturnPct: '0',
  };
  expect(chartPoints([point, { ...point, kind: 'open', cumulativeReturnPct: '-0.0001' }])).toEqual([
    { time: Date.parse(point.timestamp) / 1000, value: -0.0001 },
  ]);
  expect(chartPoints([{ ...point, cumulativeReturnPct: '9'.repeat(400) }])).toBeNull();
});
