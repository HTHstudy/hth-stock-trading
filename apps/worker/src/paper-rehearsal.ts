import { randomUUID } from 'node:crypto';
import { contentHash } from '@hth/database';
import type { createDatabase } from '@hth/database';
import { marketTradingDate, movingAverageCross } from '@hth/trading';
import type { Market, PaperEvidence } from '@hth/contracts';
import { paperRehearsalPlanSchema, rehearsalDatabaseUrl } from './paper-rehearsal-plan.js';
import { rehearsalEvidence } from './paper-rehearsal-source.js';
import { createPaperWorker } from './paper-worker.js';
export interface RehearsalCheck {
  market: Market;
  check: string;
  passed: boolean;
}
export async function rehearsePaper(
  database: ReturnType<typeof createDatabase>,
  input: unknown,
  signal: AbortSignal,
  onCheck: (check: RehearsalCheck) => void = () => {},
) {
  signal.throwIfAborted();
  const plan = paperRehearsalPlanSchema.parse(input);
  rehearsalDatabaseUrl(database.db.$client.options.connectionString);
  const identity = await database.db.$client.query<{ name: string; role: string }>(
    'SELECT current_database() AS name, current_user AS role',
  );
  if (identity.rows[0]?.name !== 'hth_readonly_test' || identity.rows[0]?.role !== 'hth_test')
    throw new Error('UNSAFE_TEST_DATABASE');
  const workers: ReturnType<typeof createPaperWorker>[] = [];
  const checks: RehearsalCheck[] = [];
  const outcomes: {
    market: Market;
    cash: string;
    equity: string;
    dailyPnl: string;
    orders: number;
    fills: number;
    manualQuantity: string;
  }[] = [];
  const stop = () => {
    for (const worker of workers) void worker.close().catch(() => {});
  };
  signal.addEventListener('abort', stop, { once: true });
  let startedDates: string | undefined;
  const clock = async () => {
    const now = new Date(
      (await database.db.$client.query<{ now: string }>('SELECT clock_timestamp()::text AS now')).rows[0]!.now,
    ).toISOString();
    const dates = `${marketTradingDate(Date.parse(now), 'KR')}/${marketTradingDate(Date.parse(now), 'US')}`;
    startedDates ??= dates;
    if (dates !== startedDates) throw new Error('PAPER_REHEARSAL_DAY_CHANGED');
    return now;
  };
  try {
    for (const profile of plan.profiles) {
      const market = profile.instrument.market,
        currency = market === 'KR' ? 'KRW' : 'USD';
      const check = (name: string, passed: boolean) => {
        const value = { market, check: name, passed };
        checks.push(value);
        onCheck(value);
        if (!passed) throw new Error('PAPER_REHEARSAL_ASSERTION_FAILED');
      };
      async function account(manualTarget = false) {
        signal.throwIfAborted();
        const id = `paper-rehearsal-${randomUUID()}`;
        const observedAt = await clock();
        const manual = manualTarget ? profile.instrument : profile.manualInstrument;
        const created = await database.paper.createAccount(
          id,
          {
            observedAt,
            reconciled: false,
            cash: plan.cash,
            positions: [
              {
                instrument: manual,
                quantity: plan.manualQuantity,
                manualQuantity: plan.manualQuantity,
                sellableQuantity: plan.manualQuantity,
                ownership: [],
                markPrice: profile.flat[2],
                markTimestamp: observedAt,
                markObservedAt: observedAt,
              },
            ],
            dailyPnl: {
              KRW: { tradingDate: marketTradingDate(Date.parse(observedAt), 'KR'), netPnl: '0' },
              USD: { tradingDate: marketTradingDate(Date.parse(observedAt), 'US'), netPnl: '0' },
            },
          },
          'synthetic-only',
        );
        if (!created.created) throw new Error('PAPER_REHEARSAL_ACCOUNT_EXISTS');
        const version = await database.paper.configureLimits(id, 0, plan.limits);
        await database.paper.configureStrategy(id, version, {
          id: 'rehearsal-ma',
          version: movingAverageCross.version,
          enabled: true,
          definition: {
            kind: 'moving-average-cross',
            instrument: profile.instrument,
            parameters: { fastPeriod: plan.strategy.fastPeriod, slowPeriod: plan.strategy.slowPeriod },
            quantity: plan.strategy.quantity,
            maxFillQuantity: plan.strategy.maxFillQuantity,
          },
        });
        let phase: 'flat' | 'bullish' | 'bearish' = 'flat',
          stale = false;
        const source = async (
          instruments: readonly { market: Market; symbol: string }[],
          readSignal: AbortSignal,
        ): Promise<PaperEvidence[]> => {
          readSignal.throwIfAborted();
          const now = await clock();
          readSignal.throwIfAborted();
          return instruments.map((instrument) => {
            const target =
              instrument.market === profile.instrument.market && instrument.symbol === profile.instrument.symbol;
            if (!target && (instrument.market !== manual.market || instrument.symbol !== manual.symbol))
              throw new Error('PAPER_REHEARSAL_INSTRUMENT_MISMATCH');
            const evidence = rehearsalEvidence(instrument, target ? profile[phase] : profile.flat, now);
            if (stale && target) evidence.quote.timestamp = new Date(Date.parse(now) - 180000).toISOString();
            return evidence;
          });
        };
        const worker = (resume: boolean) => {
          signal.throwIfAborted();
          const item = createPaperWorker(
            database.paper,
            {
              accountId: id,
              resume,
              source: 'synthetic-only',
              strategies: [
                {
                  id: 'rehearsal-ma',
                  instrument: profile.instrument,
                  parameters: { fastPeriod: 1, slowPeriod: 2 },
                  quantity: '2',
                  maxFillQuantity: '1',
                },
              ],
            },
            source,
          );
          workers.push(item);
          return item;
        };
        return {
          id,
          worker,
          setPhase: (next: typeof phase) => {
            phase = next;
          },
          makeStale: () => {
            stale = true;
          },
        };
      }
      const round = await account();
      const paused = round.worker(false);
      await paused.start();
      await paused.step();
      await paused.close();
      check('default-paused', (await database.paper.readDashboard(round.id)).orders.length === 0);
      round.setPhase('bullish');
      const active = round.worker(true);
      await active.start();
      await active.step();
      check('buy-reserved', (await database.paper.readDashboard(round.id)).orders[0]?.state === 'READY');
      await active.step();
      check('partial-buy', (await database.paper.readDashboard(round.id)).orders[0]?.state === 'PARTIALLY_FILLED');
      await active.step();
      check('buy-complete', (await database.paper.readDashboard(round.id)).orders[0]?.state === 'FILLED');
      round.setPhase('bearish');
      await active.step();
      await active.step();
      await active.step();
      await active.close();
      const dashboard = await database.paper.readDashboard(round.id);
      const portfolio = dashboard.portfolios.find((value) => value.currency === currency)!;
      check(
        'round-trip',
        dashboard.orders.length === 2 &&
          dashboard.orders.every((order) => order.state === 'FILLED') &&
          dashboard.fills.length === 4 &&
          portfolio.cash === profile.expectedRoundTrip.cash &&
          portfolio.equity === profile.expectedRoundTrip.equity &&
          portfolio.dailyPnl === profile.expectedRoundTrip.dailyPnl,
      );
      check(
        'manual-preserved',
        dashboard.positions.length === 1 &&
          dashboard.positions[0]?.instrument.symbol === profile.manualInstrument.symbol &&
          dashboard.positions[0]?.quantity === plan.manualQuantity &&
          dashboard.positions[0]?.manualQuantity === plan.manualQuantity,
      );
      check('equity-recorded', (await database.paper.readEquityHistory(round.id)).points.length >= 5);
      check('diagnostic-recorded', Boolean((await database.paper.readDiagnostics(round.id)).items[0]?.latest));
      outcomes.push({
        market,
        cash: portfolio.cash,
        equity: portfolio.equity,
        dailyPnl: portfolio.dailyPnl,
        orders: dashboard.orders.length,
        fills: dashboard.fills.length,
        manualQuantity: plan.manualQuantity,
      });
      const restart = await account();
      restart.setPhase('bullish');
      const first = restart.worker(true);
      await first.start();
      await first.step();
      await first.step();
      await first.close();
      const preserved = await database.paper.readAccount(restart.id);
      const recovery = restart.worker(false);
      await recovery.start();
      const status = await recovery.step();
      await recovery.close();
      const recovered = await database.paper.readAccount(restart.id);
      check(
        'restart-paused',
        status.state === 'paused' &&
          contentHash(recovered.snapshot.cash) === contentHash(preserved.snapshot.cash) &&
          contentHash(
            recovered.snapshot.positions.map((position) => ({
              ...position,
              markTimestamp: null,
              markObservedAt: null,
            })),
          ) ===
            contentHash(
              preserved.snapshot.positions.map((position) => ({
                ...position,
                markTimestamp: null,
                markObservedAt: null,
              })),
            ) &&
          contentHash(recovered.snapshot.dailyPnl) === contentHash(preserved.snapshot.dailyPnl),
      );
      const resumed = restart.worker(true);
      await resumed.start();
      await resumed.step();
      check('restart-no-duplicate', (await database.paper.readDashboard(restart.id)).orders.length === 1);
      const beforeStale = await database.paper.readAccount(restart.id);
      restart.makeStale();
      let blocked = false;
      try {
        await resumed.step();
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'PAPER_OBSERVATION_STALE') throw error;
        blocked = true;
      }
      const afterStale = await database.paper.readAccount(restart.id);
      check(
        'stale-stop',
        blocked &&
          afterStale.control.stopped &&
          afterStale.leaseUntil === null &&
          afterStale.snapshot.reservations.length === 0 &&
          contentHash(afterStale.snapshot.cash) === contentHash(beforeStale.snapshot.cash) &&
          contentHash(afterStale.snapshot.positions) === contentHash(beforeStale.snapshot.positions),
      );
      const manual = await account(true);
      manual.setPhase('bullish');
      const protector = manual.worker(true);
      await protector.start();
      await protector.step();
      const rejected = await database.paper.readDashboard(manual.id);
      check(
        'duplicate-manual-buy-rejected',
        rejected.orders[0]?.state === 'RISK_REJECTED' &&
          rejected.orders[0].codes.includes('DUPLICATE_BUY') &&
          rejected.fills.length === 0,
      );
      manual.setPhase('bearish');
      await protector.step();
      await protector.close();
      const protectedView = await database.paper.readDashboard(manual.id);
      check(
        'manual-sell-blocked',
        protectedView.orders.length === 1 &&
          protectedView.fills.length === 0 &&
          protectedView.positions[0]?.manualQuantity === plan.manualQuantity &&
          protectedView.positions[0]?.quantity === plan.manualQuantity &&
          protectedView.portfolios.find((p) => p.currency === currency)?.cash === plan.cash[currency],
      );
    }
    signal.throwIfAborted();
    const normalized = { planHash: contentHash(plan), outcomes, checks };
    return { ...normalized, semanticHash: contentHash(normalized) };
  } finally {
    signal.removeEventListener('abort', stop);
    await Promise.all(workers.map((worker) => worker.close()));
  }
}
