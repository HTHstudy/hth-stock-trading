import type { StrategyResearchSnapshot } from '@hth/contracts';

export type ResearchRow = StrategyResearchSnapshot['rows'][number];

export function executionKey(row: ResearchRow) {
  return JSON.stringify(row.execution);
}

export function executionDescription(row: ResearchRow) {
  const config = row.execution;
  return `매수 ${config.buyFeeBps} / 매도 ${config.sellFeeBps} / 매도세 ${config.sellTaxBps} / 슬립 ${config.slippageBps} bps · 수량 ${config.quantity} · 호가 ${config.priceTick}${config.executionRules ? ` · 규칙 ${JSON.stringify(config.executionRules)}` : ' · 기존 체결 모델'}`;
}

export function filterRows(rows: ResearchRow[], dataset: string, execution: string) {
  return rows.filter((row) => (!dataset || row.dataset === dataset) && (!execution || executionKey(row) === execution));
}

export function strategyLabel(row: ResearchRow) {
  const labels = {
    'moving-average-cross': '이동평균 교차',
    'channel-breakout': '채널 돌파',
    'mean-reversion': '평균 회귀',
    'buy-and-hold': '매수 후 보유 · 벤치마크',
  };
  return labels[row.strategy.id];
}

export function strategyParametersLabel(row: ResearchRow, entryAfterClosedCandles: number) {
  const strategy = row.strategy;
  switch (strategy.id) {
    case 'moving-average-cross':
      return `단기 ${strategy.parameters.fastPeriod} / 장기 ${strategy.parameters.slowPeriod}봉`;
    case 'channel-breakout':
      return `진입 ${strategy.parameters.entryPeriod} / 청산 ${strategy.parameters.exitPeriod}봉`;
    case 'mean-reversion':
      return `${strategy.parameters.period}봉 · 이탈 ${strategy.parameters.entryDeviationBps}bps`;
    case 'buy-and-hold':
      return `${entryAfterClosedCandles}개 종료봉 후 1회 진입`;
  }
}

export function comparisonLabel(row: ResearchRow) {
  switch (row.comparisonStatus) {
    case 'benchmark':
      return row.tradePathObserved ? '벤치마크 자체 행' : '벤치마크 자체 행 · 0체결 미검증';
    case 'compared':
      return '벤치마크 대비 순손익 차이';
    case 'strategy-no-fills':
      return '미검증 · 전략 0체결';
    case 'benchmark-no-fills':
      return '미검증 · 벤치마크 0체결';
  }
}

export function durationLabel(milliseconds: number) {
  const seconds = Math.floor(milliseconds / 1000);
  return `${Math.floor(seconds / 86400)}일 ${Math.floor((seconds % 86400) / 3600)}시간 ${Math.floor((seconds % 3600) / 60)}분 ${seconds % 60}초`;
}
