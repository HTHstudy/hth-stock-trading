import { describe, expect, it } from 'vitest';
import { createHarness } from '../../../packages/broker/test/harness.js';
import { collectReadonlySnapshot } from './readonly-snapshot.js';
import { createDashboardSnapshot } from './dashboard-model.js';

describe('대시보드 공개 모델', () => {
  it('보유 자산을 통화별로 계산하고 계좌 참조·원본 필드를 제외한다', async () => {
    const { broker } = createHarness();
    const source = await collectReadonlySnapshot(
      broker,
      [
        { market: 'KR', symbol: '005930' },
        { market: 'US', symbol: 'AAPL' },
      ],
      '1m',
      1,
    );
    const snapshot = createDashboardSnapshot(source, '2026-10-28T00:00:00Z');
    expect(snapshot.holdings).toHaveLength(2);
    expect(snapshot.portfolios.find((item) => item.currency === 'KRW')).toMatchObject({
      value: '7200000',
      cost: '6500000',
      pnl: '700000',
    });
    expect(snapshot.watchlist).toHaveLength(2);
    expect(JSON.stringify(snapshot)).not.toMatch(/accountNo|accountSeq|reference|client_secret|access_token/);
  });

  it('큰 금액·소수점 수량을 부동소수점 오차 없이 계산하고 매입가 0을 처리한다', async () => {
    const { broker } = createHarness();
    const source = await collectReadonlySnapshot(
      broker,
      [
        { market: 'KR', symbol: '005930' },
        { market: 'US', symbol: 'AAPL' },
      ],
      '1m',
      1,
    );
    source.holdings.splice(0, source.holdings.length, {
      instrument: { market: 'US', symbol: 'AAPL' },
      name: 'Apple',
      currency: 'USD',
      quantity: '0.1',
      averagePurchasePrice: '9007199254740993.1',
      lastPrice: '9007199254740993.2',
    });
    const snapshot = createDashboardSnapshot(source, '2026-10-28T00:00:00Z');
    expect(snapshot.holdings[0]).toMatchObject({
      value: '900719925474099.32',
      cost: '900719925474099.31',
      pnl: '0.01',
    });
    source.holdings[0] = { ...source.holdings[0]!, averagePurchasePrice: '0' };
    expect(createDashboardSnapshot(source, '2026-10-28T00:00:00Z').holdings[0]?.pnlPercent).toBeNull();
  });
});
