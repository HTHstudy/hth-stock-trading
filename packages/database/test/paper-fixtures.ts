import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { PaperEvidence, PaperLedgerState, PaperOrderCandidate, PaperSignal } from '@hth/contracts';
import { marketTradingDate } from '@hth/trading';
import type { createDatabase } from '../src/index.js';

type Database = ReturnType<typeof createDatabase>;
export const testLimits = {
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
export async function freshEvidence(
  database: Database,
  symbol = '005930',
  market: 'KR' | 'US' = 'KR',
): Promise<PaperEvidence> {
  const result = await database.db.execute<{ milliseconds: string }>(
    sql`SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::text AS milliseconds`,
  );
  const now = new Date(Number(result.rows[0]!.milliseconds));
  const date = marketTradingDate(now.getTime(), market);
  const end = Math.floor(now.getTime() / 60_000) * 60_000 - 60_000;
  const day = (offset: number) => {
    const tradingDate = new Date(Date.parse(`${date}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
    const previousDate = new Date(Date.parse(`${tradingDate}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    const offsetAt = (value: string) =>
      new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        timeZoneName: 'longOffset',
      })
        .formatToParts(new Date(`${value}T12:00:00Z`))
        .find((part) => part.type === 'timeZoneName')!
        .value.replace('GMT', '');
    return {
      market,
      tradingDate,
      sessionsKnown: true,
      sessions: [
        {
          type: 'regular' as const,
          startsAt:
            market === 'KR' ? `${tradingDate}T00:00:00+09:00` : `${previousDate}T20:00:00${offsetAt(previousDate)}`,
          endsAt:
            market === 'KR'
              ? `${tradingDate}T23:59:59.999+09:00`
              : `${tradingDate}T19:59:59.999${offsetAt(tradingDate)}`,
        },
      ],
    };
  };
  const instrument = { market, symbol };
  return {
    sourcesHealthy: true,
    hasUnknownOrders: false,
    quote: { instrument, price: '1000', timestamp: now.toISOString(), observedAt: now.toISOString() },
    marketData: {
      nxtSupported: false,
      restricted: false,
      candles: [
        {
          instrument,
          interval: '1m',
          timestamp: new Date(end).toISOString(),
          tradingDate: marketTradingDate(end - 1, market),
          open: '1000',
          high: '1000',
          low: '1000',
          close: '1000',
          volume: '10',
          currency: market === 'KR' ? 'KRW' : 'USD',
          adjusted: false,
          source: 'synthetic-ledger-v1',
          isClosed: false,
        },
      ],
      candlesObservedAt: now.toISOString(),
      calendar: { today: day(0), previousBusinessDay: day(-1), nextBusinessDay: day(1) },
      calendarObservedAt: now.toISOString(),
      exchangeRate: {
        validFrom: new Date(now.getTime() - 3600_000).toISOString(),
        validUntil: new Date(now.getTime() + 3600_000).toISOString(),
      },
    },
  };
}
export async function accountFixture(
  database: Database,
  cash = '15000',
  positions: PaperLedgerState['positions'] = [],
) {
  const id = `paper-${randomUUID()}`;
  const evidence = await freshEvidence(database);
  const observedAt = evidence.quote.observedAt;
  const ledger: PaperLedgerState = {
    observedAt,
    reconciled: false,
    cash: { KRW: cash, USD: '1000' },
    positions,
    dailyPnl: {
      KRW: { tradingDate: marketTradingDate(Date.parse(observedAt), 'KR'), netPnl: '0' },
      USD: { tradingDate: marketTradingDate(Date.parse(observedAt), 'US'), netPnl: '0' },
    },
  };
  await database.paper.createAccount(id, ledger);
  let version = await database.paper.configureLimits(id, 0, testLimits);
  version = await database.paper.configureStrategy(id, version, { id: 'ma-a', version: '1.0.0', enabled: true });
  await database.paper.configureStrategy(id, version, { id: 'ma-b', version: '1.0.0', enabled: true });
  return { id, ledger };
}
export async function activate(database: Database, id: string) {
  const lease = await database.paper.acquireLease(id, 60_000);
  const view = await database.paper.readAccount(id);
  const evidence = await freshEvidence(database);
  const version = await database.paper.reconcile(id, lease.token, view.snapshot.version, {
    observedAt: evidence.quote.observedAt,
    marks: view.snapshot.positions.map((position) => ({
      instrument: position.instrument,
      markPrice: position.markPrice,
      markTimestamp: evidence.quote.timestamp,
      markObservedAt: evidence.quote.observedAt,
    })),
    dailyPnl: {
      KRW: { tradingDate: marketTradingDate(Date.parse(evidence.quote.observedAt), 'KR'), netPnl: '0' },
      USD: { tradingDate: marketTradingDate(Date.parse(evidence.quote.observedAt), 'US'), netPnl: '0' },
    },
    acknowledgement: 'PAPER_RECONCILED',
  });
  await database.paper.resume(id, lease.token, version);
  return lease;
}
export function order(
  id: string,
  evidence: PaperEvidence,
  strategyId = 'ma-a',
  quantity = '10',
  side: 'BUY' | 'SELL' = 'BUY',
) {
  const candle = evidence.marketData.candles.at(-1)!;
  const candidate: PaperOrderCandidate = {
    mode: 'paper',
    accountId: id,
    intentId: randomUUID(),
    strategyId,
    instrument: evidence.quote.instrument,
    side,
    quantity,
    limitPrice: '1000',
  };
  const signal: PaperSignal = {
    strategyVersion: '1.0.0',
    barTimestamp: candle.timestamp,
    interval: candle.interval,
    adjusted: candle.adjusted,
    source: candle.source,
  };
  return { candidate, signal };
}
