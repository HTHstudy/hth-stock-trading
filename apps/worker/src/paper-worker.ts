import { setTimeout as delay } from 'node:timers/promises';
import { Decimal } from 'decimal.js';
import { z } from 'zod';
import {
  movingAverageConfigSchema,
  paperEvidenceSchema,
  paperOrderCandidateSchema,
  paperStrategyDefinitionSchema,
} from '@hth/contracts';
import type { InstrumentId } from '@hth/contracts';
import { contentHash } from '@hth/database';
import type { createDatabase } from '@hth/database';
import { movingAverageCross, prepareStrategyData } from '@hth/trading';

const Money = Decimal.clone({ precision: 100 });
const key = (instrument: InstrumentId) => `${instrument.market}:${instrument.symbol}`;
export const paperWorkerConfigSchema = z
  .object({
    accountId: paperOrderCandidateSchema.shape.accountId,
    resume: z.boolean().default(false),
    intervalMs: z.number().int().min(100).max(10_000).default(1000),
    sourceTimeoutMs: z.number().int().min(100).max(10_000).default(5000),
    strategies: z
      .array(
        z
          .object({
            id: paperOrderCandidateSchema.shape.strategyId,
            instrument: paperOrderCandidateSchema.shape.instrument,
            parameters: movingAverageConfigSchema,
            quantity: paperOrderCandidateSchema.shape.quantity,
            maxFillQuantity: paperOrderCandidateSchema.shape.quantity,
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .refine((config) => new Set(config.strategies.map((strategy) => strategy.id)).size === config.strategies.length);

export type PaperSource = (instruments: readonly InstrumentId[], signal: AbortSignal) => Promise<unknown>;
type StrategyConfig = z.infer<typeof paperWorkerConfigSchema>['strategies'][number] & {
  revision?: number;
  configHash?: string;
};
type Ledger = ReturnType<typeof createDatabase>['paper'];
export interface PaperWorkerStatus {
  state: 'paused' | 'running';
  signals: number;
  fills: number;
  executionEnabled: false;
}

export function createPaperWorker(paper: Ledger, value: unknown, source: PaperSource) {
  const config = paperWorkerConfigSchema.parse(value);
  let strategies: StrategyConfig[] = [...config.strategies];
  const controller = new AbortController();
  let token: string | null = null;
  let epoch = -1;
  let started = false;
  let busy = false;
  let closing: Promise<void> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let renewing: Promise<void> | undefined;
  let heartbeatFailed = false;
  let pendingStart: Promise<void> | undefined;
  let pendingStep: Promise<void> | undefined;
  const assertActive = () => {
    if (heartbeatFailed) throw new Error('PAPER_WORKER_HEARTBEAT_FAILED');
    if (controller.signal.aborted) throw new Error('PAPER_WORKER_STOPPED');
  };
  async function view() {
    assertActive();
    const current = await paper.readAccount(config.accountId);
    assertActive();
    if (current.control.epoch !== epoch) throw new Error('PAPER_CONTROL_CHANGED');
    return current;
  }
  async function frame() {
    const current = await view();
    const requested = new Map(
      [
        ...strategies.map((strategy) => strategy.instrument),
        ...current.snapshot.positions.map((position) => position.instrument),
      ].map((instrument) => [key(instrument), instrument]),
    );
    const readController = new AbortController();
    const abort = () => readController.abort();
    controller.signal.addEventListener('abort', abort, { once: true });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const failed = new Promise<never>((_, reject) => {
        readController.signal.addEventListener('abort', () => reject(new Error('PAPER_SOURCE_CANCELLED')), {
          once: true,
        });
        timeout = setTimeout(() => {
          readController.abort();
        }, config.sourceTimeoutMs);
      });
      const raw = await Promise.race([source([...requested.values()], readController.signal), failed]);
      assertActive();
      const entries = z.array(paperEvidenceSchema).max(10_000).parse(raw);
      const map = new Map(entries.map((entry) => [key(entry.quote.instrument), entry]));
      if (
        map.size !== requested.size ||
        map.size !== entries.length ||
        [...requested.keys()].some((id) => !map.has(id))
      )
        throw new Error('PAPER_SOURCE_INSTRUMENT_MISMATCH');
      if (entries.some((entry) => !entry.sourcesHealthy || entry.hasUnknownOrders))
        throw new Error('PAPER_SOURCE_UNHEALTHY');
      await paper.observe(config.accountId, token!, epoch, {
        quotes: current.snapshot.positions.map((position) => map.get(key(position.instrument))!.quote),
        sourcesHealthy: true,
        hasUnknownOrders: false,
      });
      const refreshed = await view();
      return { current: refreshed, evidence: map };
    } finally {
      clearTimeout(timeout);
      controller.signal.removeEventListener('abort', abort);
      readController.abort();
    }
  }
  async function close(reason = 'WORKER_SHUTDOWN') {
    if (closing) return closing;
    controller.abort();
    clearInterval(heartbeat);
    closing = (async () => {
      await pendingStart?.catch(() => {});
      clearInterval(heartbeat);
      await pendingStep;
      await renewing;
      if (token) {
        try {
          await paper.releaseLease(config.accountId, token, reason);
        } catch (error) {
          if (!(error instanceof Error && error.message === 'PAPER_LEASE_NOT_OWNED')) throw error;
        }
      }
    })();
    return closing;
  }
  async function initialize() {
    assertActive();
    const lease = await paper.acquireLease(config.accountId, 30_000);
    token = lease.token;
    epoch = lease.epoch;
    assertActive();
    heartbeat = setInterval(() => {
      if (renewing || controller.signal.aborted) return;
      renewing = paper
        .renewLease(config.accountId, token!, 30_000)
        .then(
          () => {},
          () => {
            heartbeatFailed = true;
            controller.abort();
          },
        )
        .finally(() => {
          renewing = undefined;
        });
    }, 5000);
    await paper.recoverLease(config.accountId, token, epoch);
    const storedStrategies = await paper.readStrategies(config.accountId);
    strategies = config.strategies.flatMap((configured): StrategyConfig[] => {
      const stored = storedStrategies.find((strategy) => strategy.id === configured.id);
      if (!stored || stored.version !== movingAverageCross.version) throw new Error('PAPER_WORKER_STRATEGY_MISMATCH');
      if (!stored.enabled) return [];
      if (!stored.definition) return [configured];
      const definition = paperStrategyDefinitionSchema.parse(stored.definition);
      if (stored.definitionHash !== contentHash({ version: stored.version, definition }))
        throw new Error('PAPER_WORKER_STRATEGY_MISMATCH');
      return [
        {
          id: configured.id,
          instrument: definition.instrument,
          parameters: definition.parameters,
          quantity: definition.quantity,
          maxFillQuantity: definition.maxFillQuantity,
          revision: stored.revision,
          configHash: stored.definitionHash,
        },
      ];
    });
    if (config.resume && strategies.length === 0) throw new Error('PAPER_WORKER_NO_ENABLED_STRATEGIES');
    const { current } = await frame();
    if (config.resume) {
      await paper.resume(config.accountId, token, current.snapshot.version);
      epoch = current.control.epoch + 1;
    }
    started = true;
  }
  async function start() {
    if (started || pendingStart || token || closing) throw new Error('PAPER_WORKER_ALREADY_STARTED');
    pendingStart = initialize();
    try {
      await pendingStart;
    } catch (error) {
      await close('WORKER_START_FAILED');
      throw error;
    }
  }
  async function executeStep(): Promise<PaperWorkerStatus> {
    const { current, evidence } = await frame();
    const status: PaperWorkerStatus = {
      state: current.control.stopped ? 'paused' : 'running',
      signals: 0,
      fills: 0,
      executionEnabled: false,
    };
    if (current.control.stopped) return status;
    const prepared = new Map<string, ReturnType<typeof prepareStrategyData>>();
    for (const strategy of strategies) {
      const entry = evidence.get(key(strategy.instrument))!;
      const data = prepareStrategyData({
        ...entry.marketData,
        instrument: strategy.instrument,
        quoteTimestamp: entry.quote.timestamp,
        quoteObservedAt: entry.quote.observedAt,
        accountObservedAt: current.snapshot.observedAt,
        accountAvailable: current.snapshot.reconciled,
        asOf: current.asOf,
      });
      if (!data.ready && data.blockers.some((blocker) => blocker !== 'MARKET_CLOSED'))
        throw new Error('PAPER_WORKER_DATA_NOT_READY');
      prepared.set(strategy.id, data);
    }
    for (const intent of await paper.readOpenIntents(config.accountId)) {
      assertActive();
      const strategy = strategies.find(
        (item) => item.id === intent.candidate.strategyId && key(item.instrument) === key(intent.candidate.instrument),
      );
      if (!strategy) throw new Error('PAPER_WORKER_ORDER_MISMATCH');
      if (
        intent.recordedEpoch !== epoch ||
        !intent.decision?.validUntil ||
        Date.parse(current.asOf) >= Date.parse(intent.decision.validUntil)
      ) {
        await paper.abortOwned(config.accountId, intent.intentId, token!, epoch, 'WORKER_EXPIRED');
        continue;
      }
      if (!prepared.get(strategy.id)!.ready) continue;
      const remaining = new Money(intent.candidate.quantity).minus(intent.filledQuantity);
      const quantity = Money.min(remaining, strategy.maxFillQuantity).toFixed();
      const result = await paper.fill(
        config.accountId,
        intent.intentId,
        token!,
        {
          fillId: `fill:${contentHash({ intentId: intent.intentId, filledQuantity: intent.filledQuantity })}`,
          quantity,
        },
        evidence.get(key(strategy.instrument))!,
      );
      if (result.fill && !result.replayed) status.fills++;
    }
    for (const strategy of strategies) {
      assertActive();
      const data = prepared.get(strategy.id)!;
      if (!data.ready) continue;
      const latest = data.candles.at(-1)!;
      const account = await view();
      if (account.control.stopped) throw new Error('PAPER_CONTROL_CHANGED');
      const owned =
        account.snapshot.positions
          .find((position) => key(position.instrument) === key(strategy.instrument))
          ?.ownership.find((owner) => owner.strategyId === strategy.id)?.quantity ?? '0';
      const signal = movingAverageCross.evaluate(
        {
          instrument: strategy.instrument,
          evaluatedAt: account.asOf,
          closedCandles: data.candles,
          ownedQuantity: owned,
        },
        strategy.parameters,
      );
      if (
        signal.action === 'HOLD' ||
        (signal.action === 'BUY' && new Money(owned).gt(0)) ||
        (signal.action === 'SELL' && new Money(owned).isZero())
      )
        continue;
      const provenance = {
        strategyVersion: movingAverageCross.version,
        barTimestamp: latest.timestamp,
        interval: latest.interval,
        adjusted: latest.adjusted,
        source: latest.source,
      };
      const intentId = `order:${contentHash({ strategyId: strategy.id, instrument: strategy.instrument, side: signal.action, ...provenance })}`;
      try {
        await paper.readIntent(config.accountId, intentId);
        continue;
      } catch (error) {
        if (!(error instanceof Error && error.message === 'PAPER_INTENT_NOT_FOUND')) throw error;
      }
      const quote = evidence.get(key(strategy.instrument))!.quote;
      const unit = strategy.instrument.market === 'KR' ? '1' : '0.01';
      const price = new Money(quote.price).div(unit);
      const candidate = {
        mode: 'paper',
        accountId: config.accountId,
        intentId,
        strategyId: strategy.id,
        instrument: strategy.instrument,
        side: signal.action,
        quantity: signal.action === 'BUY' ? strategy.quantity : Money.min(owned, strategy.quantity).toFixed(),
        limitPrice: (signal.action === 'BUY' ? price.ceil() : price.floor()).mul(unit).toFixed(),
      };
      await paper.recordIntent({
        candidate,
        signal: {
          ...provenance,
          ...(strategy.configHash === undefined
            ? {}
            : { configHash: strategy.configHash, strategyRevision: strategy.revision! }),
        },
      });
      assertActive();
      await paper.reserve(config.accountId, intentId, token!, evidence.get(key(strategy.instrument))!);
      status.signals++;
    }
    return status;
  }
  async function step(): Promise<PaperWorkerStatus> {
    if (!started || busy || closing) throw new Error('PAPER_WORKER_NOT_READY');
    busy = true;
    const task = executeStep();
    pendingStep = task.then(
      () => {},
      () => {},
    );
    try {
      return await task;
    } catch (error) {
      await close('WORKER_STEP_FAILED');
      throw error;
    } finally {
      busy = false;
    }
  }
  async function run(signal: AbortSignal, onTick: (status: PaperWorkerStatus) => void = () => {}, ticks = Infinity) {
    const stop = () => {
      controller.abort();
    };
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) controller.abort();
    let completed = false;
    try {
      await start();
      for (let count = 0; count < ticks && !controller.signal.aborted; count++) {
        onTick(await step());
        if (count + 1 < ticks) await delay(config.intervalMs, undefined, { signal: controller.signal });
      }
      if (heartbeatFailed) throw new Error('PAPER_WORKER_HEARTBEAT_FAILED');
      completed = true;
    } catch (error) {
      if (heartbeatFailed) throw new Error('PAPER_WORKER_HEARTBEAT_FAILED');
      if (!signal.aborted) throw error;
    } finally {
      signal.removeEventListener('abort', stop);
      await close(signal.aborted ? 'WORKER_SHUTDOWN' : completed ? 'WORKER_FINISHED' : 'WORKER_FAILED');
    }
  }
  return { start, step, close, run };
}
