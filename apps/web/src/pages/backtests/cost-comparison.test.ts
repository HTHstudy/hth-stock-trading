import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, it } from 'vitest';
import { backtestCostPairSchema } from '@hth/contracts';
import type { BacktestCostPair } from '@shared/api/backtests';
import { CostComparison } from './cost-comparison.js';

const left = 'a'.repeat(64);
const right = 'b'.repeat(64);
function fixture(): BacktestCostPair {
  return backtestCostPairSchema.parse({
    formatVersion: 'backtest-cost-pair-v1',
    leftReportHash: left,
    rightReportHash: right,
    currency: 'USD',
    status: 'compared',
    reason: null,
    comparison: {
      lowerReportHash: right,
      higherReportHash: left,
      netPnlDelta: '-12.34',
      feesDelta: '2.5',
      lowerFillCount: 2,
      higherFillCount: 2,
      sameFillCount: true,
      changedCostFields: ['buyFeeBps', 'sellFeeBps', 'sellTaxBps', 'slippageBps'],
      sameFillTimingAndQuantity: false,
      sameSignalDecisions: true,
      interpretation: 'MODELED_COST_SCENARIO_COMPARISON',
    },
    executionEnabled: false,
    canResume: false,
  });
}
function render(data?: BacktestCostPair, options: { error?: boolean; left?: string; right?: string } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    const key = ['backtest-cost-comparison', left, right];
    if (data) client.setQueryData(key, data);
    if (options.error)
      client
        .getQueryCache()
        .find({ queryKey: key })!
        .setState({ status: 'error', error: new Error('OFFLINE') });
    return renderToString(
      createElement(QueryClientProvider, {
        client,
        children: createElement(CostComparison, { leftHash: options.left ?? left, rightHash: options.right ?? right }),
      }),
    ).replace(/<!-- -->/g, '');
  } finally {
    client.clear();
  }
}

it('비용 순서를 선택 순서로 추정하지 않고 hash와 서버 차이를 표시한다', () => {
  const html = render(fixture());
  expect(html).toContain(`낮은 비용 리포트 SHA-256</dt><dd class="font-mono">${right}`);
  expect(html).toContain(`높은 비용 리포트 SHA-256</dt><dd class="font-mono">${left}`);
  expect(html).toContain('높은 비용 − 낮은 비용');
  expect(html).toContain('$−12.34');
  expect(html).toContain('$2.50');
  for (const label of ['매수 수수료', '매도 수수료', '매도세', '슬리피지']) expect(html).toContain(label);
  expect(html).toContain('일치 (건수만 비교)');
  expect(html).toContain('모델 체결 경로: 시각·수량</dt><dd>불일치');
  expect(html).not.toContain('실제 체결 경로');
  expect(html).toContain('신호 판단</dt><dd>일치');
  expect(html).toContain('실행·재개 승인이 아닙니다');
  expect(html).not.toContain('text-green');
});

it('0건과 0 차이를 비용 영향 검증 성공으로 표시하지 않는다', () => {
  const value = fixture();
  if (value.status !== 'compared') throw new Error('FIXTURE');
  Object.assign(value.comparison, {
    lowerFillCount: 0,
    higherFillCount: 0,
    netPnlDelta: '0',
    feesDelta: '0',
    sameFillTimingAndQuantity: null,
    sameSignalDecisions: true,
  });
  const html = render(backtestCostPairSchema.parse(value));
  expect(html).toContain('0 / 0건');
  expect(html).toContain('$0.00');
  expect(html).toContain('비용 영향 검증이나 거래 성공을 뜻하지 않습니다');
  expect(html).toContain('모델 체결 경로: 시각·수량</dt><dd>미검증 (체결 없음 또는 증거 없음)');
  expect(html).not.toContain('모델 체결 경로: 시각·수량</dt><dd>일치');
});

it('양쪽 0건의 잘못된 캐시 일치 값도 모델 체결 경로 미검증으로 표시한다', () => {
  const value = fixture();
  if (value.status !== 'compared') throw new Error('FIXTURE');
  Object.assign(value.comparison, { lowerFillCount: 0, higherFillCount: 0, sameFillTimingAndQuantity: true });
  const html = render(value);
  expect(html).toContain('모델 체결 경로: 시각·수량</dt><dd>미검증 (체결 없음 또는 증거 없음)');
  expect(html).not.toContain('모델 체결 경로: 시각·수량</dt><dd>일치');
});

it('추적 증거 null을 일치로 바꾸지 않는다', () => {
  const value = fixture();
  if (value.status !== 'compared') throw new Error('FIXTURE');
  value.comparison.sameFillTimingAndQuantity = null;
  value.comparison.sameSignalDecisions = null;
  expect(render(value).match(/미검증 \(체결 없음 또는 증거 없음\)/g)).toHaveLength(2);
});

it.each([
  ['SAME_REPORT', '같은 리포트'],
  ['DIFFERENT_DATASET', '동결 데이터셋'],
  ['DIFFERENT_STRATEGY', '전략 조건'],
  ['DIFFERENT_EXECUTION', '비용 외 체결 조건'],
  ['COSTS_NOT_ORDERED', '정렬할 수 없습니다'],
] as const)('비교 불가 사유 %s를 표시한다', (reason, label) => {
  const data = backtestCostPairSchema.parse({ ...fixture(), status: 'incomparable', reason, comparison: null });
  const html = render(data);
  expect(html).toContain('비용 비교 불가');
  expect(html).toContain(label);
  expect(html).not.toContain('순손익 차이');
});

it('대기와 오류에서 이전 비교값을 표시하지 않는다', () => {
  expect(render()).toContain('비용 비교를 검증하고 있습니다');
  const html = render(fixture(), { error: true });
  expect(html).toContain('role="alert"');
  expect(html).not.toContain('순손익 차이');
  expect(html).not.toContain('$−12.34');
});

it('선택 hash 변경과 응답 hash 불일치에서 이전 결과를 숨긴다', () => {
  expect(render(fixture(), { right: 'c'.repeat(64) })).not.toContain('순손익 차이');
  expect(render({ ...fixture(), rightReportHash: 'c'.repeat(64) })).not.toContain('순손익 차이');
  expect(render(fixture(), { left: right, right: left })).not.toContain('순손익 차이');
});

it('두 리포트가 선택되기 전에는 비교를 표시하지 않는다', () => {
  expect(render(fixture(), { right: '' })).toBe('');
  expect(render(fixture(), { left: '' })).toBe('');
});
