import type { createDatabase } from '@hth/database';
import { marketTradingDate, movingAverageCross } from '@hth/trading';

export async function initializeSyntheticPaper(database: ReturnType<typeof createDatabase>, id: string) {
  const now = new Date().toISOString();
  const created = await database.paper.createAccount(
    id,
    {
      cash: { KRW: '15000', USD: '1000' },
      positions: [],
      observedAt: now,
      reconciled: false,
      dailyPnl: {
        KRW: { tradingDate: marketTradingDate(Date.parse(now), 'KR'), netPnl: '0' },
        USD: { tradingDate: marketTradingDate(Date.parse(now), 'US'), netPnl: '0' },
      },
    },
    'synthetic-only',
  );
  if (created.created) {
    const limits = {
      KRW: {
        maxOrderAmount: '100000',
        maxInstrumentAmount: '200000',
        maxDailyLoss: '10000',
        buyCostBps: '10',
        sellCostBps: '30',
      },
      USD: {
        maxOrderAmount: '1000',
        maxInstrumentAmount: '2000',
        maxDailyLoss: '100',
        buyCostBps: '10',
        sellCostBps: '30',
      },
      maxPositions: 5,
    };
    const version = await database.paper.configureLimits(id, 0, limits);
    await database.paper.configureStrategy(id, version, {
      id: 'demo-ma',
      version: movingAverageCross.version,
      enabled: true,
      definition: {
        kind: 'moving-average-cross',
        instrument: { market: 'KR', symbol: '005930' },
        parameters: { fastPeriod: 1, slowPeriod: 2 },
        quantity: '2',
        maxFillQuantity: '1',
      },
    });
  }
  return created.created;
}
