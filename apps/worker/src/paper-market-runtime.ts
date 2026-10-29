import { createHash } from 'node:crypto';
import type { createDatabase } from '@hth/database';
import { paperStrategyDefinitionSchema } from '@hth/contracts';
import type { InstrumentId } from '@hth/contracts';
import { contentHash } from '@hth/database';
import { marketTradingDate, movingAverageCross } from '@hth/trading';
import type { createTossReadonlyBroker } from '@hth/broker/toss';
import type { createPaperWorker } from './paper-worker.js';
import type { PaperWorkerStatus } from './paper-worker.js';
import { createPaperMarketSource } from './paper-market-source.js';
import type { PaperMarketConfig } from './paper-market-config.js';

type Database = ReturnType<typeof createDatabase>;
type Paper = Pick<
  Database['paper'],
  'stop' | 'createAccount' | 'configureLimits' | 'configureStrategy' | 'readStrategies'
> & { readAccount: (id: string) => Promise<{ snapshot: { positions: readonly { instrument: InstrumentId }[] } }> };
export interface PaperMarketDependencies {
  paper: Paper;
  withBrokerLease: (key: number, operation: (signal: AbortSignal) => Promise<void>) => Promise<void>;
  prepare: () => Promise<void>;
  createBroker: typeof createTossReadonlyBroker;
  createWorker: (
    config: Parameters<typeof createPaperWorker>[1],
    source: Parameters<typeof createPaperWorker>[2],
  ) => Pick<ReturnType<typeof createPaperWorker>, 'run'>;
  now?: () => number;
}

export async function runPaperMarket(
  config: PaperMarketConfig,
  dependencies: PaperMarketDependencies,
  signal: AbortSignal,
  onTick: (status: PaperWorkerStatus) => void,
) {
  signal.throwIfAborted();
  if (config.prepare) await dependencies.prepare();
  signal.throwIfAborted();
  const paper = dependencies.paper;
  if (config.stop) {
    await paper.stop(config.accountId, 'PAPER_MARKET_EMERGENCY_STOP');
    return;
  }
  const key = createHash('sha256').update(config.clientId!).digest().readInt32BE(0);
  // Acquire the SAME DB/client lock as every existing readonly command before
  // constructing the broker or touching the Paper account.
  await dependencies.withBrokerLease(key, async (leaseSignal) => {
    const lifetime = new AbortController();
    const combined = AbortSignal.any([signal, leaseSignal, lifetime.signal]);
    let pendingRead: Promise<unknown> | undefined;
    try {
      combined.throwIfAborted();
      if (config.initialize) {
        const now = new Date((dependencies.now ?? Date.now)()).toISOString();
        const created = await paper.createAccount(config.accountId, {
          cash: { KRW: '1000000', USD: '1000' },
          positions: [],
          observedAt: now,
          reconciled: false,
          dailyPnl: {
            KRW: { tradingDate: marketTradingDate(Date.parse(now), 'KR'), netPnl: '0' },
            USD: { tradingDate: marketTradingDate(Date.parse(now), 'US'), netPnl: '0' },
          },
        });
        if (!created.created) throw new Error('PAPER_MARKET_ACCOUNT_EXISTS');
        const version = await paper.configureLimits(config.accountId, 0, {
          KRW: {
            maxOrderAmount: '100000',
            maxInstrumentAmount: '200000',
            maxDailyLoss: '10000',
            buyCostBps: '10',
            sellCostBps: '30',
          },
          USD: {
            maxOrderAmount: '100',
            maxInstrumentAmount: '200',
            maxDailyLoss: '10',
            buyCostBps: '10',
            sellCostBps: '30',
          },
          maxPositions: 5,
        });
        await paper.configureStrategy(config.accountId, version, {
          id: 'market-ma',
          version: movingAverageCross.version,
          enabled: true,
          definition: {
            kind: 'moving-average-cross',
            instrument: config.instrument,
            parameters: { fastPeriod: 5, slowPeriod: 20 },
            quantity: '1',
            maxFillQuantity: '1',
          },
        });
      }
      const stored = await paper.readStrategies(config.accountId);
      if (!stored.length || stored.length > 5) throw new Error('PAPER_MARKET_STRATEGIES_INVALID');
      const strategies = stored.map((strategy) => {
        const definition = paperStrategyDefinitionSchema.parse(strategy.definition);
        if (
          strategy.version !== movingAverageCross.version ||
          strategy.definitionHash !== contentHash({ version: strategy.version, definition }) ||
          definition.parameters.slowPeriod + 1 > 200
        )
          throw new Error('PAPER_MARKET_STRATEGIES_INVALID');
        return {
          id: strategy.id,
          instrument: definition.instrument,
          parameters: definition.parameters,
          quantity: definition.quantity,
          maxFillQuantity: definition.maxFillQuantity,
        };
      });
      const account = await paper.readAccount(config.accountId);
      const instruments = new Set(
        [
          ...strategies.map((item) => item.instrument),
          ...account.snapshot.positions.map((item) => item.instrument),
        ].map((item) => `${item.market}:${item.symbol}`),
      );
      if (instruments.size > 5) throw new Error('PAPER_MARKET_INSTRUMENT_LIMIT');
      combined.throwIfAborted();
      const broker = dependencies.createBroker({
        clientId: config.clientId!,
        clientSecret: config.clientSecret!,
        signal: combined,
      });
      const source = createPaperMarketSource(broker, 1, dependencies.now);
      const worker = dependencies.createWorker(
        {
          accountId: config.accountId,
          resume: config.resume,
          intervalMs: 10_000,
          sourceTimeoutMs: 10_000,
          strategies,
        },
        (instruments, readSignal) => {
          pendingRead = source(instruments, readSignal);
          return pendingRead;
        },
      );
      await worker.run(combined, onTick, config.ticks);
      combined.throwIfAborted();
    } finally {
      lifetime.abort();
      // Do not release the token lock while a timed-out source is still issuing reads.
      await pendingRead?.catch(() => {});
    }
  });
}
