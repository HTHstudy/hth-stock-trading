import { randomUUID } from 'node:crypto';
import { contentHash } from '@hth/database';
import type { PaperReviewSnapshot } from '@hth/contracts';
import { paperReviewCheckpoint, reviewPaperCheckpoints } from '../src/paper-review.js';
const h = (s: string) => contentHash(s);
function snapshots() {
  const before: PaperReviewSnapshot = {
    formatVersion: 'paper-review-snapshot-v1',
    source: 'toss-readonly',
    scope: h('account-scope'),
    asOf: '2026-11-02T00:00:00.000000Z',
    version: 0,
    epoch: 0,
    stopped: true,
    leasePresent: false,
    limitsHash: h('limits'),
    strategyHash: h('strategy'),
    cash: { KRW: '10000', USD: '1000' },
    dailyPnl: { KRW: { tradingDate: '2026-11-02', netPnl: '0' }, USD: { tradingDate: '2026-11-01', netPnl: '0' } },
    positions: [],
    basis: [],
    intents: [],
    fills: [],
    reservations: [],
    events: [{ key: h('created'), kind: 'ACCOUNT_CREATED', createdAt: '2026-11-02T00:00:00.000000Z' }],
  };
  const after = structuredClone(before);
  after.asOf = '2026-11-02T00:02:00.000000Z';
  after.version = 10;
  after.epoch = 3;
  const instrument = { market: 'KR' as const, symbol: '005930' },
    strategyKey = h('strategy-id');
  after.cash.KRW = '8999';
  after.positions = [
    {
      instrument,
      quantity: '1',
      manualQuantity: '0',
      sellableQuantity: '1',
      ownership: [{ strategyKey, quantity: '1' }],
    },
  ];
  after.basis = [{ instrument, strategyKey, quantity: '1', amount: '1001' }];
  after.intents = [
    {
      key: h('intent'),
      dedupeKey: h('dedupe'),
      requestHash: h('request'),
      requestVerified: true,
      dedupeVerified: true,
      strategyKey,
      instrument,
      side: 'BUY',
      quantity: '2',
      filledQuantity: '1',
      filledNotional: '1000',
      paidCosts: '1',
      state: 'ABORTED',
    },
  ];
  after.fills = [
    {
      key: h('fill'),
      intentKey: h('intent'),
      requestHash: h('fill-request'),
      requestVerified: true,
      quantity: '1',
      price: '1000',
      notional: '1000',
      costs: '1',
      realizedPnl: '0',
      createdAt: '2026-11-02T00:01:00.000001Z',
    },
  ];
  after.reservations = [
    { intentKey: h('intent'), quantity: '1', cashAmount: '1001', sellQuantity: '0', active: false },
  ];
  after.events.push(
    ...(
      [
        'LEASE_ACQUIRED',
        'ACCOUNT_OBSERVED',
        'STRATEGY_DIAGNOSED',
        'INTENT_RECORDED',
        'PAPER_FILL_RECORDED',
        'LEASE_RELEASED',
      ] as const
    ).map((kind, index) => ({ key: h(kind), kind, createdAt: `2026-11-02T00:01:01.00000${index}Z` })),
  );
  return { before, after };
}

export function continuationFixture(input?: { before: PaperReviewSnapshot; after: PaperReviewSnapshot }) {
  const { before, after } = input ?? snapshots();
  const at = (offset: number) => new Date(Date.parse(after.asOf) + offset).toISOString();
  const parentRunId = randomUUID(),
    parentLaunchId = randomUUID();
  const beforeCheckpoint = paperReviewCheckpoint(before),
    afterCheckpoint = paperReviewCheckpoint(after);
  const report = reviewPaperCheckpoints(beforeCheckpoint, afterCheckpoint, at(1000));
  const launch = {
    formatVersion: 'owned-paper-launch-v1',
    id: parentLaunchId,
    runId: parentRunId,
    nonce: randomUUID(),
    runnerHash: h('runner'),
    argumentsHash: h('arguments'),
    startedAt: new Date(Date.parse(before.asOf) - 1000).toISOString(),
    automaticRetry: false,
    executionEnabled: false,
    canResume: false,
  };
  const exit = {
    formatVersion: 'owned-paper-exit-v1',
    launchId: parentLaunchId,
    runId: parentRunId,
    nonce: launch.nonce,
    launchHash: contentHash(launch),
    exitCode: report.verdict === 'consistent-observed-state' ? 0 : 2,
    signal: null,
    forced: false,
    clockUnverified: false,
    observedExitAt: at(3000),
    executionEnabled: false,
    canResume: false,
  };
  const bundle = {
    request: {
      formatVersion: 'authorized-paper-validation-v1',
      market: 'KR',
      prerequisite: 'kr-2026-11-02',
      startsAt: before.asOf,
      deadline: at(30 * 60000),
      resumeRequested: true,
      maxTicks: 60,
      buildHash: h('build'),
      resourcesHash: h('resources'),
      automaticRetry: false,
      executionEnabled: false,
    },
    result: {
      formatVersion: 'authorized-paper-validation-result-v1',
      market: 'KR',
      state: report.verdict === 'consistent-observed-state' ? 'completed' : 'completed-with-incomplete-review',
      resumeRequested: true,
      maxTicks: 60,
      completedTicks: 60,
      runningTicks: 60,
      verdict: report.verdict,
      stoppedAndCleaned: true,
      intents: after.intents.length,
      fills: after.fills.length,
      finishedAt: at(2000),
      executionEnabled: false,
      automaticRetry: false,
    },
    before: beforeCheckpoint,
    after: afterCheckpoint,
    review: { formatVersion: 'paper-review-artifact-v1', report, hash: contentHash(report) },
    launch,
    exit: { ...exit, hash: contentHash(exit) },
  };
  return { bundle, context: { parentRunId, parentLaunchId, market: 'KR', asOf: at(4000) } };
}
