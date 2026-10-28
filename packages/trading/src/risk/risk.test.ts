import { expect, it } from 'vitest';
import { paperRiskInputSchema } from '@hth/contracts';
import type { PaperRiskInput } from '@hth/contracts';
import example from '../../../../examples/paper-risk-input.json' with { type: 'json' };
import { initialPaperControl, stopPaperControl } from './control.js';
import { evaluatePaperRisk, isPaperRiskCurrent } from './evaluate.js';

function fixture() {
  const input = paperRiskInputSchema.parse(structuredClone(example));
  input.control = { mode: 'paper', stopped: false, epoch: 1, reason: 'SYNTHETIC_TEST_ONLY' };
  return input;
}
function position(input: PaperRiskInput, manual = '90', owned = '10') {
  input.snapshot!.positions = [
    {
      instrument: input.candidate.instrument,
      quantity: String(BigInt(manual) + BigInt(owned)),
      manualQuantity: manual,
      sellableQuantity: String(BigInt(manual) + BigInt(owned)),
      ownership: [{ strategyId: input.candidate.strategyId, quantity: owned }],
      markPrice: '1000',
      markTimestamp: input.asOf,
      markObservedAt: input.asOf,
    },
  ];
}
function current(input: PaperRiskInput) {
  return {
    asOf: input.asOf,
    control: input.control,
    snapshotVersion: input.snapshot!.version,
    candidate: input.candidate,
    runtime: input.runtime,
  };
}
it('기본 긴급 정지는 키와 무관하게 새 의도를 차단하고 입력을 변경하지 않는다', () => {
  const input = fixture();
  const initial = initialPaperControl();
  expect(initial.stopped).toBe(true);
  input.control = initial;
  const original = structuredClone(input);
  expect(evaluatePaperRisk(input)).toMatchObject({
    canReserve: false,
    executionEnabled: false,
    blockers: ['EMERGENCY_STOP'],
    reservation: null,
  });
  expect(input).toEqual(original);
  expect(stopPaperControl(initial, 'AGAIN')).toMatchObject({ stopped: true, epoch: 1 });
});
it('정밀 비용을 포함한 예약 후보만 반환하며 검사 시간과 버전을 묶는다', () => {
  const input = fixture();
  const result = evaluatePaperRisk(input);
  expect(result).toMatchObject({
    canReserve: true,
    blockers: [],
    dataBlockers: [],
    validUntil: '2026-03-25T01:04:00.000Z',
    reservation: { notional: '10000', costs: '10', cashAmount: '10010', sellQuantity: '0' },
  });
  expect(isPaperRiskCurrent(result, current(input))).toBe(true);
  expect(isPaperRiskCurrent(result, { ...current(input), control: stopPaperControl(input.control, 'EMERGENCY') })).toBe(
    false,
  );
  expect(isPaperRiskCurrent(result, { ...current(input), snapshotVersion: 1 })).toBe(false);
  expect(isPaperRiskCurrent(result, { ...current(input), asOf: result.validUntil! })).toBe(false);
  expect(isPaperRiskCurrent(result, { ...current(input), asOf: '2026-03-25T10:02:59+09:00' })).toBe(false);
  expect(isPaperRiskCurrent(result, { ...current(input), candidate: { ...input.candidate, quantity: '11' } })).toBe(
    false,
  );
  expect(
    isPaperRiskCurrent(result, { ...current(input), candidate: { ...input.candidate, accountId: 'another-account' } }),
  ).toBe(false);
  expect(isPaperRiskCurrent(result, { ...current(input), runtime: { ...input.runtime, sourcesHealthy: false } })).toBe(
    false,
  );
});
it('누락·live·잘못된 수량과 계좌 입력은 실패 시 차단한다', () => {
  const input = fixture();
  for (const value of [
    null,
    {},
    { ...input, candidate: { ...input.candidate, mode: 'live' } },
    { ...input, candidate: { ...input.candidate, quantity: '0.1' } },
  ])
    expect(evaluatePaperRisk(value)).toMatchObject({ canReserve: false, blockers: ['INVALID_INPUT'] });
  expect(evaluatePaperRisk({ ...input, limits: null }).blockers).toContain('LIMITS_NOT_CONFIGURED');
  expect(evaluatePaperRisk({ ...input, control: null }).blockers).toContain('CONTROL_UNAVAILABLE');
  expect(evaluatePaperRisk({ ...input, snapshot: null }).blockers).toContain('SNAPSHOT_UNAVAILABLE');
  expect(
    evaluatePaperRisk({ ...input, snapshot: { ...input.snapshot, accountId: 'another-account' } }).blockers,
  ).toContain('ACCOUNT_MISMATCH');
});
it('데이터 지연·API 장애·미확인 주문·worker 소유권 상실을 차단한다', () => {
  const input = fixture();
  expect(
    evaluatePaperRisk({ ...input, quote: { ...input.quote, timestamp: '2026-03-25T09:00:00+09:00' } }).dataBlockers,
  ).toContain('QUOTE_STALE');
  expect(evaluatePaperRisk({ ...input, runtime: { ...input.runtime, workerOwned: false } }).blockers).toContain(
    'WORKER_NOT_OWNED',
  );
  expect(evaluatePaperRisk({ ...input, runtime: { ...input.runtime, sourcesHealthy: false } }).blockers).toContain(
    'SOURCE_UNHEALTHY',
  );
  expect(evaluatePaperRisk({ ...input, runtime: { ...input.runtime, hasUnknownOrders: true } }).blockers).toContain(
    'UNKNOWN_ORDERS',
  );
  expect(evaluatePaperRisk({ ...input, runtime: { ...input.runtime, strategyEnabled: false } }).blockers).toContain(
    'STRATEGY_DISABLED',
  );
  expect(evaluatePaperRisk({ ...input, snapshot: { ...input.snapshot, reconciled: false } }).dataBlockers).toContain(
    'ACCOUNT_UNAVAILABLE',
  );
});
it('한도 경계는 비용까지 합산하고 일일 손실 한도 도달은 매수·매도 모두 차단한다', () => {
  const input = fixture();
  input.limits!.KRW.buyCostBps = '0';
  input.candidate.quantity = '100';
  expect(evaluatePaperRisk(input).canReserve).toBe(true);
  input.limits!.KRW.buyCostBps = '1';
  expect(evaluatePaperRisk(input).blockers).toContain('ORDER_AMOUNT_LIMIT');
  input.limits!.KRW.maxInstrumentAmount = '100000';
  expect(evaluatePaperRisk(input).blockers).toContain('INSTRUMENT_AMOUNT_LIMIT');
  input.candidate.quantity = '10';
  input.snapshot!.dailyPnl.KRW.netPnl = '-10000';
  expect(evaluatePaperRisk(input).blockers).toContain('DAILY_LOSS_LIMIT');
  input.candidate.side = 'SELL';
  position(input);
  expect(evaluatePaperRisk(input).blockers).toContain('DAILY_LOSS_LIMIT');
});
it('다른 전략의 매수 예약도 현금과 보유 종목 수에 포함한다', () => {
  const input = fixture();
  input.snapshot!.cash.KRW = '15000';
  input.snapshot!.reservations = [
    {
      intentId: 'other',
      strategyId: 'other',
      instrument: { market: 'KR', symbol: '005380' },
      side: 'BUY',
      remainingQuantity: '10',
      limitPrice: '1000',
      costBps: '10',
    },
  ];
  expect(evaluatePaperRisk(input).blockers).toContain('INSUFFICIENT_CASH');
  input.limits!.maxPositions = 1;
  expect(evaluatePaperRisk(input).blockers).toContain('MAX_POSITIONS');
  input.snapshot!.reservations[0]!.instrument = input.candidate.instrument;
  expect(evaluatePaperRisk(input).blockers).toContain('DUPLICATE_BUY');
  input.snapshot!.reservations[0]!.intentId = input.candidate.intentId;
  expect(evaluatePaperRisk(input).blockers).toContain('DUPLICATE_INTENT');
});
it('수동 보유분은 매도할 수 없고 자기 전략의 미예약 수량만 허용한다', () => {
  const input = fixture();
  input.candidate.side = 'SELL';
  position(input, '100', '0');
  expect(evaluatePaperRisk(input).blockers).toContain('INSUFFICIENT_OWNED_QUANTITY');
  position(input);
  expect(evaluatePaperRisk(input)).toMatchObject({
    canReserve: true,
    reservation: { cashAmount: '0', sellQuantity: '10' },
  });
  input.snapshot!.reservations = [
    {
      intentId: 'sell-pending',
      strategyId: input.candidate.strategyId,
      instrument: input.candidate.instrument,
      side: 'SELL',
      remainingQuantity: '7',
      limitPrice: '1000',
      costBps: '30',
    },
  ];
  expect(evaluatePaperRisk(input).blockers).toContain('INSUFFICIENT_OWNED_QUANTITY');
  input.candidate.quantity = '3';
  expect(evaluatePaperRisk(input).canReserve).toBe(true);
  input.candidate.strategyId = 'another-strategy';
  expect(evaluatePaperRisk(input).blockers).toContain('INSUFFICIENT_OWNED_QUANTITY');
});
it('소유권 불일치·중복 종목·과다 예약은 원장 오류로 차단한다', () => {
  const input = fixture();
  position(input);
  input.snapshot!.positions[0]!.quantity = '99';
  expect(evaluatePaperRisk(input).blockers).toContain('OWNERSHIP_MISMATCH');
  input.snapshot!.positions.push(input.snapshot!.positions[0]!);
  expect(evaluatePaperRisk(input).blockers).toContain('INVALID_LEDGER');
  input.snapshot!.positions = [];
  input.snapshot!.reservations = [
    {
      intentId: 'oversell',
      strategyId: 'absent',
      instrument: input.candidate.instrument,
      side: 'SELL',
      remainingQuantity: '1',
      limitPrice: '1000',
      costBps: '0',
    },
  ];
  expect(evaluatePaperRisk(input).blockers).toContain('RESERVATION_MISMATCH');
});
it('모든 보유분이 중복 매수·종목 수에 포함되지만 외화 평가액을 원화와 합산하지 않는다', () => {
  const input = fixture();
  input.snapshot!.positions = [
    {
      instrument: { market: 'US', symbol: 'AAPL' },
      quantity: '1',
      manualQuantity: '1',
      sellableQuantity: '1',
      ownership: [],
      markPrice: '10',
      markTimestamp: null,
      markObservedAt: '2026-03-24T10:00:00Z',
    },
  ];
  expect(evaluatePaperRisk(input).canReserve).toBe(true);
  input.limits!.maxPositions = 1;
  expect(evaluatePaperRisk(input).blockers).toContain('MAX_POSITIONS');
  position(input, '1', '0');
  expect(evaluatePaperRisk(input).blockers).toContain('DUPLICATE_BUY');
});
it('평가 가격·일일 손익 날짜의 신선도를 검사하고 유효시간을 가장 빠른 만료로 제한한다', () => {
  const input = fixture();
  position(input);
  input.candidate.side = 'SELL';
  input.snapshot!.positions[0]!.markObservedAt = '2026-03-25T10:01:30+09:00';
  expect(evaluatePaperRisk(input).validUntil).toBe('2026-03-25T01:03:30.000Z');
  input.snapshot!.positions[0]!.markObservedAt = '2026-03-25T10:00:00+09:00';
  expect(evaluatePaperRisk(input).blockers).toContain('POSITION_MARK_STALE');
  input.snapshot!.dailyPnl.KRW.tradingDate = '2026-03-24';
  expect(evaluatePaperRisk(input).blockers).toContain('DAILY_PNL_DATE_MISMATCH');
});
it('정지 epoch가 상한이어도 정지 상태로 전환한다', () => {
  expect(
    stopPaperControl({ mode: 'paper', stopped: false, epoch: Number.MAX_SAFE_INTEGER - 1, reason: 'TEST' }, 'STOP')
      .stopped,
  ).toBe(true);
  const input = fixture();
  input.control!.epoch = Number.MAX_SAFE_INTEGER - 1;
  expect(evaluatePaperRisk(input).blockers).toContain('CONTROL_UNAVAILABLE');
});
it('원화가 있어도 USD 부족을 대신 채우지 않고 달러 비용은 센트로 올림한다', () => {
  const input = fixture();
  const instrument = { market: 'US', symbol: 'AAPL' } as const;
  input.asOf = '2026-03-25T10:03:00-04:00';
  input.candidate = { ...input.candidate, instrument, quantity: '1', limitPrice: '10' };
  input.quote = { instrument, price: '10', timestamp: input.asOf, observedAt: input.asOf };
  input.snapshot!.observedAt = input.asOf;
  input.snapshot!.dailyPnl.USD = { tradingDate: '2026-03-25', netPnl: '0' };
  input.snapshot!.dailyPnl.KRW.netPnl = '-999999';
  input.marketData.candles = input.marketData.candles.map((candle) => ({
    ...candle,
    instrument,
    currency: 'USD',
    timestamp: '2026-03-25T10:02:00-04:00',
    open: '10',
    high: '10',
    low: '10',
    close: '10',
  }));
  input.marketData.candlesObservedAt = input.asOf;
  input.marketData.calendarObservedAt = input.asOf;
  for (const day of Object.values(input.marketData.calendar!)) {
    day.market = 'US';
    day.sessions = [
      { type: 'regular', startsAt: `${day.tradingDate}T09:30:00-04:00`, endsAt: `${day.tradingDate}T16:00:00-04:00` },
    ];
  }
  input.marketData.exchangeRate = { validFrom: '2026-03-25T09:00:00-04:00', validUntil: '2026-03-25T18:00:00-04:00' };
  expect(evaluatePaperRisk(input)).toMatchObject({
    canReserve: true,
    reservation: { cashAmount: '10.01', costs: '0.01' },
  });
  input.snapshot!.cash.USD = '10';
  expect(evaluatePaperRisk(input).blockers).toContain('INSUFFICIENT_CASH');
});
it('기존 손익에 신규 비용을 더하면 손실 한도에 닿는 주문도 차단한다', () => {
  const input = fixture();
  input.snapshot!.dailyPnl.KRW.netPnl = '-9990';
  expect(evaluatePaperRisk(input).blockers).toContain('DAILY_LOSS_LIMIT');
});
it('안전 정수 범위를 넘는 금액도 경계에서 정확히 비교한다', () => {
  const input = fixture();
  input.candidate.quantity = '1';
  input.candidate.limitPrice = '9007199254740993';
  input.snapshot!.cash.KRW = '9007199254740993';
  input.limits!.KRW = {
    ...input.limits!.KRW,
    maxOrderAmount: '9007199254740993',
    maxInstrumentAmount: '9007199254740993',
    buyCostBps: '0',
  };
  expect(evaluatePaperRisk(input)).toMatchObject({ canReserve: true, reservation: { cashAmount: '9007199254740993' } });
  input.limits!.KRW.maxOrderAmount = '9007199254740992';
  expect(evaluatePaperRisk(input).blockers).toContain('ORDER_AMOUNT_LIMIT');
});
