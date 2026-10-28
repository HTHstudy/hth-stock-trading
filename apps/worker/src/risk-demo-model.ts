import { paperRiskInputSchema } from '@hth/contracts';
import type { PaperRiskInput } from '@hth/contracts';
import { evaluatePaperRisk, initialPaperControl, isPaperRiskCurrent, stopPaperControl } from '@hth/trading';

export function createRiskDemo(value: unknown) {
  const fixture = paperRiskInputSchema.parse(value);
  const base = () => {
    const input = structuredClone(fixture);
    input.control = { mode: 'paper', stopped: false, epoch: 1, reason: 'SYNTHETIC_DEMO_ONLY' };
    return input;
  };
  const results: {
    scenario: string;
    canReserve: boolean;
    blockers: ReturnType<typeof evaluatePaperRisk>['blockers'];
    dataBlockers: ReturnType<typeof evaluatePaperRisk>['dataBlockers'];
    reservation: ReturnType<typeof evaluatePaperRisk>['reservation'];
  }[] = [];
  const add = (scenario: string, input: PaperRiskInput) => {
    const result = evaluatePaperRisk(input);
    results.push({
      scenario,
      canReserve: result.canReserve,
      blockers: result.blockers,
      dataBlockers: result.dataBlockers,
      reservation: result.reservation,
    });
    return result;
  };
  const stopped = base();
  stopped.control = initialPaperControl();
  add('DEFAULT_STOP', stopped);
  const input = base();
  const approved = add('ELIGIBLE_SYNTHETIC_BUY', input);
  const overLimit = base();
  overLimit.candidate.quantity = '100';
  add('ORDER_LIMIT_WITH_COSTS', overLimit);
  const cash = base();
  cash.snapshot!.cash.KRW = '15000';
  cash.snapshot!.reservations = [
    {
      intentId: 'other-reservation',
      strategyId: 'other-strategy',
      instrument: { market: 'KR', symbol: '005380' },
      side: 'BUY',
      remainingQuantity: '10',
      limitPrice: '1000',
      costBps: '10',
      filledNotional: '0',
      paidCosts: '0',
    },
  ];
  add('PENDING_CASH_RESERVED', cash);
  const manual = base();
  manual.candidate.side = 'SELL';
  manual.snapshot!.positions = [
    {
      instrument: manual.candidate.instrument,
      quantity: '100',
      manualQuantity: '100',
      sellableQuantity: '100',
      ownership: [],
      markPrice: '1000',
      markTimestamp: manual.asOf,
      markObservedAt: manual.asOf,
    },
  ];
  add('MANUAL_POSITION_PROTECTED', manual);
  const owned = structuredClone(manual);
  owned.snapshot!.positions[0]!.manualQuantity = '90';
  owned.snapshot!.positions[0]!.ownership = [{ strategyId: owned.candidate.strategyId, quantity: '10' }];
  add('OWN_STRATEGY_SELL', owned);
  const sellReserved = structuredClone(owned);
  sellReserved.snapshot!.reservations = [
    {
      intentId: 'reserved-sell',
      strategyId: sellReserved.candidate.strategyId,
      instrument: sellReserved.candidate.instrument,
      side: 'SELL',
      remainingQuantity: '7',
      limitPrice: '1000',
      costBps: '30',
      filledNotional: '0',
      paidCosts: '0',
    },
  ];
  add('PENDING_SELL_RESERVED', sellReserved);
  const duplicate = structuredClone(owned);
  duplicate.candidate.side = 'BUY';
  add('DUPLICATE_BUY_BLOCKED', duplicate);
  const loss = base();
  loss.snapshot!.dailyPnl.KRW.netPnl = '-10000';
  add('DAILY_LOSS_LIMIT', loss);
  const unhealthy = base();
  unhealthy.runtime.sourcesHealthy = false;
  add('SOURCE_FAILURE', unhealthy);
  const unknown = base();
  unknown.runtime.hasUnknownOrders = true;
  add('UNKNOWN_ORDER', unknown);
  const stale = base();
  stale.quote.timestamp = '2026-03-25T09:00:00+09:00';
  add('STALE_QUOTE', stale);
  const context = {
    asOf: input.asOf,
    control: input.control,
    snapshotVersion: input.snapshot!.version,
    candidate: input.candidate,
    runtime: input.runtime,
  };
  return {
    formatVersion: 'paper-risk-demo-v1',
    source: 'synthetic-only',
    mode: 'paper',
    executionEnabled: false,
    notAnOrderApproval: true,
    initialStopped: stopped.control.stopped,
    currentBeforeStop: isPaperRiskCurrent(approved, context),
    currentAfterStop: isPaperRiskCurrent(approved, {
      ...context,
      control: stopPaperControl(input.control, 'SYNTHETIC_EMERGENCY'),
    }),
    results,
  };
}
