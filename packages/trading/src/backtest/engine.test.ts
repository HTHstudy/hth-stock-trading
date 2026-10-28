import { expect, it } from 'vitest';
import type { BacktestConfig } from '@hth/contracts';
import { testDataset } from '../../test/dataset.js';
import type { Strategy } from '../strategy/types.js';
import { movingAverageCross } from '../strategy/moving-average.js';
import { buildHistoricalDataset } from '../market-data/historical.js';
import { runBacktest } from './engine.js';

const config: BacktestConfig = {
  initialCash: '1000',
  quantity: '1',
  priceTick: '1',
  buyFeeBps: '0',
  sellFeeBps: '0',
  sellTaxBps: '0',
  slippageBps: '0',
};
const bars = [
  { open: 100, close: 100 },
  { open: 110, close: 110 },
  { open: 120, close: 120 },
  { open: 110, close: 110 },
];
const script: Strategy<Record<number, 'BUY' | 'SELL'>> = {
  id: 'script',
  version: 'test',
  evaluate: (context, actions) => ({ action: actions[context.closedCandles.length] ?? 'HOLD', reason: 'TEST' }),
};
const input = {
  dataset: testDataset(bars),
  strategy: script,
  strategyConfig: { 1: 'BUY', 3: 'SELL' } as const,
  config,
};

it('동일 봉 종가 대신 다음 거래일 시가에 체결하며 동일 입력은 같은 결과를 만든다', () => {
  const report = runBacktest(input);
  expect(report.fills.map((fill) => fill.price)).toEqual(['110', '110']);
  expect(report.fills[0]?.barTimestamp).toBe(input.dataset.candles[1]?.timestamp);
  expect(report.metrics).toMatchObject({ tradeCount: 1, fillCount: 2, netPnl: '0', winRatePct: '0.0000000000' });
  expect(runBacktest(input)).toEqual(report);
});
it('수수료·매도세·불리한 슬리피지·호가 반올림을 비용에 반영한다', () => {
  const report = runBacktest({
    ...input,
    config: { ...config, buyFeeBps: '100', sellFeeBps: '200', sellTaxBps: '300', slippageBps: '100' },
  });
  expect(report.fills.map((fill) => fill.price)).toEqual(['112', '108']);
  expect(report.metrics).toMatchObject({
    endingCash: '987',
    netPnl: '-13',
    realizedPnl: '-13',
    unrealizedPnl: '0',
    totalFees: '5',
    totalTax: '4',
    cumulativeReturnPct: '-1.3000000000',
  });
});
it('종료 대기 전 분봉에는 체결하지 않는다', () => {
  const dataset = testDataset(bars, true);
  const report = runBacktest({ ...input, dataset, strategyConfig: { 1: 'BUY' } });
  expect(report.fills[0]?.barTimestamp).toBe(dataset.candles[2]?.timestamp);
  expect(report.fills[0]?.timestamp).toBe('2026-03-09T13:32:00.000Z');
});
it('미청산 포지션은 강제 매도하지 않고 미실현 손익과 MDD를 계산한다', () => {
  const report = runBacktest({
    ...input,
    dataset: testDataset([
      { open: 100, close: 100 },
      { open: 100, close: 50 },
    ]),
    strategyConfig: { 1: 'BUY' },
  });
  expect(report.metrics).toMatchObject({
    endingCash: '900',
    endingQuantity: '1',
    endingEquity: '950',
    netPnl: '-50',
    realizedPnl: '0',
    unrealizedPnl: '-50',
    tradeCount: 0,
    winRatePct: null,
    maxDrawdownPct: '5.0000000000',
  });
});
it('마지막 신호·현금 부족·포지션 없는 매도는 체결하지 않는다', () => {
  expect(runBacktest({ ...input, strategyConfig: { 4: 'BUY' } }).signals.at(-1)?.status).toBe('UNFILLED_END');
  const shortage = runBacktest({ ...input, config: { ...config, initialCash: '1' } });
  expect(shortage.fills).toHaveLength(0);
  expect(shortage.signals[0]?.status).toBe('INSUFFICIENT_CASH');
  expect(shortage.signals[2]?.status).toBe('NO_POSITION');
});
it('이미 보유 중이면 추가 매수하지 않고 무거래의 승률은 null이다', () => {
  const report = runBacktest({ ...input, strategyConfig: { 1: 'BUY', 2: 'BUY' } });
  expect(report.fills).toHaveLength(1);
  expect(report.signals[1]?.status).toBe('ALREADY_LONG');
  expect(runBacktest({ ...input, strategyConfig: {} }).metrics).toMatchObject({
    netPnl: '0',
    fillCount: 0,
    winRatePct: null,
    maxDrawdownPct: '0.0000000000',
  });
});
it('전략은 불변 prefix만 받고 미래 봉 수정은 이전 신호를 바꾸지 않는다', () => {
  const seen: number[] = [];
  const spy: Strategy<null> = {
    id: 'prefix',
    version: 'test',
    evaluate(context) {
      seen.push(context.closedCandles.length);
      expect(Object.isFrozen(context.closedCandles)).toBe(true);
      expect(Object.isFrozen(context.closedCandles[0])).toBe(true);
      return { action: 'HOLD', reason: 'TEST' };
    },
  };
  runBacktest({ ...input, strategy: spy, strategyConfig: null });
  expect(seen).toEqual([1, 2, 3, 4]);
  const original = testDataset([3, 2, 1, 2, 3, 2, 1].map((price) => ({ open: price, close: price })));
  const changed = testDataset([3, 2, 1, 2, 3, 2, 100].map((price) => ({ open: price, close: price })));
  const first = runBacktest({
    ...input,
    dataset: original,
    strategy: movingAverageCross,
    strategyConfig: { fastPeriod: 1, slowPeriod: 2 },
  });
  const second = runBacktest({
    ...input,
    dataset: changed,
    strategy: movingAverageCross,
    strategyConfig: { fastPeriod: 1, slowPeriod: 2 },
  });
  expect(first.signals.slice(0, 6)).toEqual(second.signals.slice(0, 6));
});
it('0원 초기자산·미완성 입력·위조 종료 증거를 거부한다', () => {
  expect(() => runBacktest({ ...input, config: { ...config, initialCash: '0' } })).toThrow('INVALID_BACKTEST_CONFIG');
  expect(() =>
    runBacktest({ ...input, dataset: { ...input.dataset, coverage: { ...input.dataset.coverage, complete: false } } }),
  ).toThrow('INVALID_BACKTEST_DATASET');
  expect(() =>
    runBacktest({
      ...input,
      dataset: {
        ...input.dataset,
        assessments: input.dataset.assessments.map((entry) => ({ ...entry, usableAt: '2026-03-01T00:00:00Z' })),
      },
    }),
  ).toThrow('BACKTEST_DATASET_PROOF_MISMATCH');
});
it('비용 차감 후 이익인 왕복 거래만 승률에 포함한다', () => {
  const report = runBacktest({ ...input, strategyConfig: { 1: 'BUY', 2: 'SELL' } });
  expect(report.metrics).toMatchObject({ realizedPnl: '10', tradeCount: 1, winRatePct: '100.0000000000' });
});
it('USD 비용은 센트 단위로 올림하고 매수·매도 호가를 불리하게 반올림한다', () => {
  const report = runBacktest({
    ...input,
    dataset: testDataset(
      Array.from({ length: 5 }, () => ({ open: 1.234, close: 1.234 })),
      true,
    ),
    config: { ...config, priceTick: '0.01', buyFeeBps: '1', sellFeeBps: '1', sellTaxBps: '1' },
  });
  expect(report.fills.map((fill) => fill.price)).toEqual(['1.24', '1.23']);
  expect(report.metrics).toMatchObject({ totalFees: '0.02', totalTax: '0.01', netPnl: '-0.04' });
});
it('체결 대기 중 같은 방향은 유지하고 반대 신호는 이전 의도를 폐기한다', () => {
  const dataset = testDataset(bars.slice(0, 2), true);
  const repeated = runBacktest({ ...input, dataset, strategyConfig: { 1: 'BUY', 2: 'BUY' } });
  expect(repeated.signals.map((signal) => signal.status)).toEqual(['UNFILLED_END', 'PENDING_EXISTS']);
  const reversed = runBacktest({ ...input, dataset, strategyConfig: { 1: 'BUY', 2: 'SELL' } });
  expect(reversed.signals.map((signal) => signal.status)).toEqual(['SUPERSEDED', 'NO_POSITION']);
  expect(reversed.fills).toHaveLength(0);
});
it('안전 정수 범위를 넘는 원금과 가격도 현금·손익을 손실 없이 계산한다', () => {
  const base = 100000000000000000001n;
  const source = testDataset(bars.slice(0, 3));
  const dataset = buildHistoricalDataset({
    ...source,
    observations: source.observations.map((entry, index) => {
      const price = (base + BigInt(index)).toString();
      return { ...entry, candle: { ...entry.candle, open: price, high: price, low: price, close: price } };
    }),
  });
  const report = runBacktest({
    ...input,
    dataset,
    strategyConfig: { 1: 'BUY' },
    config: { ...config, initialCash: (base + 1000n).toString() },
  });
  expect(report.metrics).toMatchObject({
    endingCash: '999',
    netPnl: '1',
    unrealizedPnl: '1',
    endingEquity: (base + 1001n).toString(),
  });
});
it('국내 통합 일봉을 정규장 시가로 추측하지 않는다', () => {
  const source = input.dataset;
  const dataset = buildHistoricalDataset({
    ...source,
    calendars: source.calendars.map((entry) => ({
      ...entry,
      day: {
        ...entry.day,
        sessions: [
          ...entry.day.sessions,
          {
            type: 'after',
            startsAt: `${entry.day.tradingDate}T15:30:00+09:00`,
            endsAt: `${entry.day.tradingDate}T20:00:00+09:00`,
          },
        ],
      },
    })),
  });
  expect(() => runBacktest({ ...input, dataset })).toThrow('UNSUPPORTED_KR_DAILY_SESSION');
});
it('미국 일봉은 현지 자정·프리마켓 대신 정규장 시가에서 체결한다', () => {
  const source = input.dataset;
  const instrument = { market: 'US', symbol: 'AAPL' } as const;
  const dataset = buildHistoricalDataset({
    ...source,
    request: { ...source.request, instrument },
    instrument: { ...source.instrument, currency: 'USD' },
    calendars: source.calendars.map((entry) => ({
      ...entry,
      day: {
        ...entry.day,
        market: 'US',
        sessions: [
          {
            type: 'pre',
            startsAt: `${entry.day.tradingDate}T04:00:00-04:00`,
            endsAt: `${entry.day.tradingDate}T09:30:00-04:00`,
          },
          {
            type: 'regular',
            startsAt: `${entry.day.tradingDate}T09:30:00-04:00`,
            endsAt: `${entry.day.tradingDate}T16:00:00-04:00`,
          },
          {
            type: 'after',
            startsAt: `${entry.day.tradingDate}T16:00:00-04:00`,
            endsAt: `${entry.day.tradingDate}T20:00:00-04:00`,
          },
        ],
      },
    })),
    observations: source.observations.map((entry) => ({
      ...entry,
      candle: { ...entry.candle, instrument, currency: 'USD', timestamp: `${entry.candle.tradingDate}T00:00:00-04:00` },
    })),
  });
  const report = runBacktest({ ...input, dataset });
  expect(report.fills[0]?.timestamp).toBe('2026-03-10T13:30:00.000Z');
  expect(report.equity.filter((point) => point.kind === 'close')[0]?.timestamp).toBe('2026-03-10T00:00:00.000Z');
});
