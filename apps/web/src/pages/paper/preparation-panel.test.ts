import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, it } from 'vitest';
import { paperPreparationDashboardSchema } from '@hth/contracts';
import { PreparationPanel } from './preparation-panel.js';

function snapshot() {
  const asOf = new Date().toISOString();
  const checks = Object.fromEntries(
    [
      'paperSource',
      'stopped',
      'noLease',
      'initialControl',
      'limitsMatch',
      'initialCash',
      'emptyPositions',
      'unreconciled',
      'initialPnl',
      'noOrders',
      'noFills',
      'noReservations',
      'strategyMatches',
      'historyMatches',
      'preparationReceipt',
    ].map((key) => [key, true]),
  );
  return paperPreparationDashboardSchema.parse({
    status: 'ready',
    asOf,
    executionEnabled: false,
    canResume: false,
    marketReadiness: 'not-checked',
    accounts: ['KR', 'US'].map((market) => ({
      market,
      status: 'available',
      details: {
        observedAt: asOf,
        clockVerified: true,
        preparationMatches: true,
        stopped: true,
        leasePresent: false,
        checks,
        dailyReviewRequired: true,
        dailyDates: [
          { currency: 'KRW', stored: '2026-10-30', current: '2026-11-02' },
          { currency: 'USD', stored: '2026-10-30', current: '2026-11-01' },
        ],
        plan: {
          hash: 'a'.repeat(64),
          symbol: market === 'KR' ? '005930' : 'AAPL',
          currency: market === 'KR' ? 'KRW' : 'USD',
          cash: market === 'KR' ? '1000000' : '1000',
          maxOrderAmount: market === 'KR' ? '200000' : '300',
          maxInstrumentAmount: market === 'KR' ? '200000' : '300',
          maxDailyLoss: market === 'KR' ? '10000' : '10',
          maxPositions: 1,
          fastPeriod: 5,
          slowPeriod: 20,
          quantity: '1',
          maxFillQuantity: '1',
        },
      },
    })),
  });
}
function render(client: QueryClient) {
  return renderToString(createElement(QueryClientProvider, { client, children: createElement(PreparationPanel) }));
}
it('초기 설정 일치와 일일 기준 검토 필요를 동시에 표시한다', () => {
  const client = new QueryClient();
  try {
    client.setQueryData(['paper-preparation'], snapshot());
    const html = render(client);
    expect(html).toContain('국내');
    expect(html).toContain('미국');
    expect(html).toContain('초기 준비 설정 일치');
    expect(html).toContain('일일 기준 날짜 검토 필요');
    expect(html).toContain('매매 승인이나 시장 검증 완료를 뜻하지 않습니다');
    expect(html).not.toContain('재개하기');
  } finally {
    client.clear();
  }
});
it('조회 오류나 오래된 캐시에 남은 준비 결과를 정상으로 표시하지 않는다', () => {
  for (const kind of ['error', 'expired']) {
    const client = new QueryClient();
    try {
      client.setQueryData(['paper-preparation'], snapshot(), {
        updatedAt: Date.now() - (kind === 'expired' ? 60000 : 0),
      });
      if (kind === 'error')
        client
          .getQueryCache()
          .find({ queryKey: ['paper-preparation'] })!
          .setState({ status: 'error', error: new Error('OFFLINE'), fetchStatus: 'idle' });
      const html = render(client);
      expect(html).toContain('이전 결과를 정상 상태로 표시하지 않습니다');
      expect(html).not.toContain('초기 준비 설정 일치');
      expect(html).not.toContain('AAPL');
    } finally {
      client.clear();
    }
  }
});
it('미확인 DB 시각을 날짜 일치나 검토 불필요로 표시하지 않는다', () => {
  const client = new QueryClient();
  try {
    const value = snapshot();
    value.accounts[0]!.details!.clockVerified = false;
    value.accounts[0]!.details!.dailyReviewRequired = null;
    client.setQueryData(['paper-preparation'], value);
    const html = render(client);
    expect(html).toContain('일일 기준 검토 여부 확인 불가');
    expect(html).toContain('DB 시각을 확인하지 못했습니다');
  } finally {
    client.clear();
  }
});
