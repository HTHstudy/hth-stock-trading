import { expect, it } from 'vitest';
import { contentHash } from '@hth/database';
import type { PaperReviewSnapshot } from '@hth/contracts';
import { paperReviewCheckpoint, reviewPaperCheckpoints } from './paper-review.js';

const h = (s: string) => contentHash(s),
  asOf = '2026-11-02T00:03:00.000Z';
function reviewFixture() {
  const before: PaperReviewSnapshot = {
    formatVersion: 'paper-review-snapshot-v1',
    source: 'synthetic-only',
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
const compare = (a: PaperReviewSnapshot, b: PaperReviewSnapshot) =>
  reviewPaperCheckpoints(paperReviewCheckpoint(a), paperReviewCheckpoint(b), asOf);
it('부분 체결 후 잔량 정리·수수료·소유권·원가가 일치하는 관측 구간을 검토한다', () => {
  const { before, after } = reviewFixture();
  const report = compare(before, after);
  expect(report).toMatchObject({
    verdict: 'consistent-observed-state',
    canResume: false,
    executionEnabled: false,
    evidence: { newIntents: 1, newFills: 1, leaseAcquisitions: 1, leaseReleases: 1 },
    comparison: { costs: { KRW: '1', USD: '0' } },
  });
  expect(Object.values(report.checks).every((v) => v === 'passed')).toBe(true);
});
it('자료 누락·변조·다른 계좌/출처·시간 역행은 정상 비교로 처리하지 않는다', () => {
  const { before, after } = reviewFixture();
  const checkpoint = paperReviewCheckpoint(before);
  expect(reviewPaperCheckpoints(checkpoint, null, asOf)).toMatchObject({ verdict: 'incomplete', comparison: null });
  const tampered = paperReviewCheckpoint(after);
  tampered.hash = '0'.repeat(64);
  expect(reviewPaperCheckpoints(checkpoint, tampered, asOf).limitations).toContain('INVALID_CHECKPOINT');
  for (const patch of [{ scope: h('other') }, { source: 'toss-readonly' as const }, { asOf: '2026-10-01T00:00:00Z' }])
    expect(compare(before, { ...after, ...patch })).toMatchObject({
      verdict: 'issues-found',
      comparison: null,
      checks: { comparable: 'failed' },
    });
});
it('신호나 체결이 없으면 원장이 같아도 실행 경로를 검증 완료로 표시하지 않는다', () => {
  const { before } = reviewFixture();
  const report = compare(before, { ...before, asOf });
  expect(report.verdict).toBe('incomplete');
  expect(report.checks.fillPath).toBe('unverified');
  expect(report.checks.intentPath).toBe('unverified');
});
it('현금·원가 오차와 수동 보유분 변경을 검출한다', () => {
  for (const kind of ['cash', 'basis', 'manual']) {
    const { before, after } = reviewFixture();
    if (kind === 'cash') after.cash.KRW = '9000';
    if (kind === 'basis') after.basis[0]!.amount = '1002';
    if (kind === 'manual') {
      const i = { market: 'KR' as const, symbol: '000660' };
      before.positions.push({
        instrument: i,
        quantity: '5',
        manualQuantity: '5',
        sellableQuantity: '5',
        ownership: [],
      });
      after.positions.push({ instrument: i, quantity: '4', manualQuantity: '4', sellableQuantity: '4', ownership: [] });
    }
    const report = compare(before, after);
    expect(report.verdict).toBe('issues-found');
    expect(
      report.checks[
        kind === 'cash' ? 'cashMatchesFills' : kind === 'basis' ? 'costBasisReplay' : 'manualHoldingsPreserved'
      ],
    ).toBe('failed');
  }
});
it('중복 의도·체결·dedupe 및 누적 수량 불일치를 거부한다', () => {
  for (const kind of ['intent', 'fill', 'dedupe', 'quantity']) {
    const { before, after } = reviewFixture();
    if (kind === 'intent') after.intents.push(structuredClone(after.intents[0]!));
    if (kind === 'fill') after.fills.push(structuredClone(after.fills[0]!));
    if (kind === 'dedupe') after.intents.push({ ...after.intents[0]!, key: h('another') });
    if (kind === 'quantity') after.intents[0]!.filledQuantity = '2';
    expect(compare(before, after)).toMatchObject({ verdict: 'issues-found', checks: { afterIntegrity: 'failed' } });
  }
});
it('정지·lease·미체결·활성 예약 정리가 안 됐으면 그대로 보고한다', () => {
  const { before, after } = reviewFixture();
  after.stopped = false;
  after.leasePresent = true;
  after.intents[0]!.state = 'PARTIALLY_FILLED';
  after.reservations[0]!.active = true;
  expect(compare(before, after)).toMatchObject({
    verdict: 'issues-found',
    checks: { stopped: 'failed', leaseReleased: 'failed', noOpenIntents: 'failed', noActiveReservations: 'failed' },
  });
  expect(after.stopped).toBe(false);
  expect(after.reservations[0]!.active).toBe(true);
});
it('기존 체결 기록의 변경을 보존 실패로 표시한다', () => {
  const { after } = reviewFixture();
  const before = structuredClone(after);
  before.asOf = '2026-11-02T00:02:00.000000Z';
  const next = structuredClone(after);
  next.asOf = asOf;
  next.fills[0]!.createdAt = '2026-11-02T00:01:00.000002Z';
  expect(compare(before, next)).toMatchObject({ verdict: 'issues-found', checks: { priorFillsPreserved: 'failed' } });
});
it('같은 원가 묶음의 체결 시각이 같으면 UUID로 순서를 만들어 원가를 검증하지 않는다', () => {
  const { before, after } = reviewFixture();
  after.fills.push({ ...after.fills[0]!, key: h('fill-two') });
  after.intents[0]!.filledQuantity = '2';
  after.intents[0]!.filledNotional = '2000';
  after.intents[0]!.paidCosts = '2';
  after.intents[0]!.state = 'FILLED';
  after.reservations[0]!.quantity = '0';
  after.cash.KRW = '7998';
  after.positions[0]!.quantity = '2';
  after.positions[0]!.sellableQuantity = '2';
  after.positions[0]!.ownership[0]!.quantity = '2';
  after.basis[0]!.quantity = '2';
  after.basis[0]!.amount = '2002';
  const report = compare(before, after);
  expect(report.verdict).toBe('incomplete');
  expect(report.checks.costBasisReplay).toBe('unverified');
  expect(report.checks.cashMatchesFills).toBe('passed');
  expect(report.limitations).toContain('AMBIGUOUS_FILL_ORDER');
});
it('달러 센트 비용을 부동소수점 오차 없이 비교한다', () => {
  const { before, after } = reviewFixture();
  const us = { market: 'US' as const, symbol: 'AAPL' };
  after.cash = { KRW: '10000', USD: '999.98' };
  after.positions[0]!.instrument = us;
  after.basis[0]!.instrument = us;
  after.basis[0]!.amount = '0.02';
  after.intents[0]!.instrument = us;
  after.intents[0]!.filledNotional = '0.01';
  after.intents[0]!.paidCosts = '0.01';
  Object.assign(after.fills[0]!, { price: '0.01', notional: '0.01', costs: '0.01' });
  expect(compare(before, after)).toMatchObject({
    verdict: 'consistent-observed-state',
    comparison: { costs: { USD: '0.01' } },
  });
});
it('외부 대사·복수 lease 구간을 단일 실행 검증으로 확정하지 않는다', () => {
  const { before, after } = reviewFixture();
  after.asOf = asOf;
  after.events.push(
    { key: h('reconcile'), kind: 'ACCOUNT_RECONCILED', createdAt: asOf },
    { key: h('lease-two'), kind: 'LEASE_ACQUIRED', createdAt: asOf },
  );
  const report = compare(before, after);
  expect(report.verdict).toBe('incomplete');
  expect(report.checks.externalChanges).toBe('unverified');
  expect(report.limitations).toContain('MULTIPLE_LEASE_CYCLES');
});
it('매도 시 비례 원가의 원 단위 내림과 실현 손익을 다시 계산한다', () => {
  const { before, after } = reviewFixture();
  const instrument = after.positions[0]!.instrument,
    strategyKey = after.basis[0]!.strategyKey;
  before.positions = [
    {
      instrument,
      quantity: '3',
      manualQuantity: '0',
      sellableQuantity: '3',
      ownership: [{ strategyKey, quantity: '3' }],
    },
  ];
  before.basis = [{ instrument, strategyKey, quantity: '3', amount: '100' }];
  after.positions[0]!.quantity = '2';
  after.positions[0]!.sellableQuantity = '2';
  after.positions[0]!.ownership[0]!.quantity = '2';
  Object.assign(after.basis[0]!, { quantity: '2', amount: '67' });
  after.cash.KRW = '10049';
  Object.assign(after.intents[0]!, {
    side: 'SELL',
    quantity: '1',
    filledQuantity: '1',
    filledNotional: '50',
    paidCosts: '1',
    state: 'FILLED',
  });
  Object.assign(after.fills[0]!, { price: '50', notional: '50', realizedPnl: '16' });
  after.reservations = [];
  expect(compare(before, after)).toMatchObject({
    verdict: 'consistent-observed-state',
    comparison: { realizedPnl: { KRW: '16' } },
  });
  after.fills[0]!.realizedPnl = '15';
  expect(compare(before, after).checks.costBasisReplay).toBe('failed');
});
it('DB가 검증한 체결 요청 hash와 기록 시각의 상한을 확인한다', () => {
  for (const kind of ['request', 'future']) {
    const { before, after } = reviewFixture();
    if (kind === 'request') after.fills[0]!.requestVerified = false;
    else after.fills[0]!.createdAt = '2026-11-02T00:03:00.000001Z';
    expect(compare(before, after)).toMatchObject({ verdict: 'issues-found', checks: { afterIntegrity: 'failed' } });
  }
});
it('마이크로초 역행과 snapshot 이전에 작성됐지만 뒤에 나타난 기록을 구분한다', () => {
  const { before } = reviewFixture();
  before.asOf = '2026-11-02T00:00:00.000002Z';
  const reversed = { ...before, asOf: '2026-11-02T00:00:00.000001Z' };
  expect(compare(before, reversed).checks.comparable).toBe('failed');
  const later = structuredClone(before);
  later.asOf = asOf;
  later.events.push({ key: h('late-commit'), kind: 'ACCOUNT_OBSERVED', createdAt: before.asOf });
  const report = compare(before, later);
  expect(report.verdict).toBe('incomplete');
  expect(report.limitations).toContain('AMBIGUOUS_INTERVAL');
});

it('기존 수동 소수점 보유량도 새 체결과 분리해 보존 여부를 확인한다', () => {
  const { before, after } = reviewFixture();
  const manual = {
    instrument: { market: 'US' as const, symbol: 'MSFT' },
    quantity: '0.5',
    manualQuantity: '0.5',
    sellableQuantity: '0.5',
    ownership: [],
  };
  before.positions.push(structuredClone(manual));
  after.positions.push(structuredClone(manual));
  expect(compare(before, after).verdict).toBe('consistent-observed-state');
  Object.assign(after.positions[1]!, { quantity: '0.25', manualQuantity: '0.25', sellableQuantity: '0.25' });
  expect(compare(before, after).checks.manualHoldingsPreserved).toBe('failed');
});

it('주문 의도만으로 전략 신호를 추정하지 않고 진단 기록이 없으면 미검증으로 남긴다', () => {
  const { before, after } = reviewFixture();
  after.events = after.events.filter((event) => event.kind !== 'STRATEGY_DIAGNOSED');
  const report = compare(before, after);
  expect(report.verdict).toBe('incomplete');
  expect(report.checks.intentPath).toBe('passed');
  expect(report.checks.diagnosticsRecorded).toBe('unverified');
  expect(report.checks).not.toHaveProperty('signalPath');
});
