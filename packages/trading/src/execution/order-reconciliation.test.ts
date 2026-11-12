import { expect, it } from 'vitest';
import type { OrderObservation } from '@hth/contracts';
import { reconcileOrderObservations } from './order-reconciliation.js';
const fixture = (): OrderObservation => ({
  formatVersion: 'order-observation-v1',
  scope: 'a'.repeat(64),
  observedAt: '2026-11-11T01:00:10.000Z',
  orderReference: 'fake-order',
  instrument: { market: 'US', symbol: 'AAPL' },
  side: 'BUY',
  currency: 'USD',
  definition: {
    type: 'limit',
    validity: 'day',
    quantity: '5',
    limitPrice: '110',
    amount: null,
    orderedAt: '2026-11-11T01:00:00.000Z',
  },
  state: 'partial',
  execution: {
    quantity: '1',
    averagePrice: '100',
    amount: '100',
    commission: '1',
    tax: '0.1',
    lastFilledAt: '2026-11-11T01:00:01.000Z',
    settlementDate: null,
  },
});
function pair() {
  const before = fixture(),
    after = fixture();
  after.observedAt = '2026-11-11T01:00:20.000Z';
  after.execution = {
    ...after.execution,
    quantity: '3',
    averagePrice: '106.6666666666666666666666666',
    amount: '320',
    commission: '3',
    tax: '0.3',
    lastFilledAt: '2026-11-11T01:00:02.000Z',
  };
  return { before, after };
}
it('부분 체결 증가의 정확한 누적 차이만 계산하고 체결가/개별 이벤트를 만들지 않는다', () => {
  const { before, after } = pair();
  const copy = structuredClone({ before, after });
  const result = reconcileOrderObservations(before, after);
  expect(result.outcome).toBe('progress');
  expect(result.reasons).toEqual([]);
  expect(result.delta).toEqual({ quantity: '2', amount: '220', commission: '2', tax: '0.2' });
  expect(result).not.toHaveProperty('price');
  expect(result).not.toHaveProperty('fillId');
  expect(result.canApplyToLedger).toBe(false);
  expect({ before, after }).toEqual(copy);
});
it('처음 본 체결을 전체 신규 체결로 인식하지 않는다', () => {
  const r = reconcileOrderObservations(null, fixture());
  expect(r.outcome).toBe('baseline-required');
  expect(r.delta).toBeNull();
});
it('같은 값/십진 표현/나중 조회는 증분을 만들지 않는다', () => {
  const a = fixture(),
    b = fixture();
  b.observedAt = '2026-11-11T01:00:20.000Z';
  b.execution.quantity = '1.000';
  b.execution.commission = '1.00';
  expect(reconcileOrderObservations(a, b)).toMatchObject({ outcome: 'unchanged', delta: null });
  expect(reconcileOrderObservations(a, a)).toMatchObject({ outcome: 'unchanged', delta: null });
});
it.each(['scope', 'orderReference', 'side', 'instrument', 'currency'] as const)(
  '식별 범위 %s 변경은 차단한다',
  (key) => {
    const { before, after } = pair();
    if (key === 'scope') after.scope = 'b'.repeat(64);
    if (key === 'orderReference') after.orderReference = 'another';
    if (key === 'side') after.side = 'SELL';
    if (key === 'instrument') after.instrument.symbol = 'MSFT';
    if (key === 'currency') {
      after.currency = 'KRW';
      after.instrument.market = 'KR';
    }
    expect(reconcileOrderObservations(before, after)).toMatchObject({
      outcome: 'blocked',
      reasons: ['IDENTITY_CHANGED'],
      delta: null,
    });
  },
);
it.each(['quantity', 'limitPrice', 'amount', 'orderedAt', 'type', 'validity'] as const)(
  '같은 주문의 요청 정의 %s 변경은 차단한다',
  (key) => {
    const { before, after } = pair();
    const patches = {
      quantity: '6',
      limitPrice: '111',
      amount: '100',
      orderedAt: '2026-11-11T01:00:00.001Z',
      type: 'market',
      validity: 'closing',
    };
    const changed = { ...after, definition: { ...after.definition, [key]: patches[key] } };
    expect(reconcileOrderObservations(before, changed)).toMatchObject({
      outcome: 'blocked',
      reasons: ['DEFINITION_CHANGED'],
    });
  },
);
it('조회 역행과 동률 시각의 다른 값은 최신값을 선택하지 않는다', () => {
  const { before, after } = pair();
  after.observedAt = before.observedAt;
  expect(reconcileOrderObservations(before, after)).toMatchObject({
    outcome: 'blocked',
    reasons: ['CONFLICTING_OBSERVATION'],
  });
  after.observedAt = '2026-11-11T01:00:09.000Z';
  expect(reconcileOrderObservations(before, after)).toMatchObject({
    outcome: 'blocked',
    reasons: ['OBSERVATION_REVERSED'],
  });
});
it.each(['quantity', 'amount', 'lastFilledAt'] as const)('누적 %s 역행은 자동 보정하지 않는다', (key) => {
  const { before, after } = pair();
  if (key === 'quantity') after.execution.quantity = '0';
  if (key === 'amount') after.execution.amount = '99';
  if (key === 'lastFilledAt') after.execution.lastFilledAt = '2026-11-11T01:00:00.000Z';
  const reason = { quantity: 'QUANTITY_REVERSED', amount: 'AMOUNT_REVERSED', lastFilledAt: 'FILL_TIME_REVERSED' }[key];
  expect(reconcileOrderObservations(before, after)).toMatchObject({ outcome: 'blocked', reasons: [reason] });
});
it.each(['pending', 'partial', 'filled'] as const)('상태 %s와 수량이 모순이면 차단한다', (state) => {
  const { before, after } = pair();
  after.state = state;
  if (state === 'partial') after.execution.quantity = '5';
  expect(reconcileOrderObservations(before, after)).toMatchObject({
    outcome: 'blocked',
    reasons: ['STATE_QUANTITY_MISMATCH'],
  });
});
it('완료 전량 체결과 취소 직전 추가 부분 체결을 구분한다', () => {
  const { before, after } = pair();
  after.state = 'filled';
  after.execution.quantity = '5';
  expect(reconcileOrderObservations(before, after).outcome).toBe('progress');
  after.state = 'canceled';
  after.execution.quantity = '3';
  after.canceledAt = '2026-11-11T01:00:03.000Z';
  expect(reconcileOrderObservations(before, after).delta?.quantity).toBe('2');
});
it.each(['canceled', 'rejected', 'replaced', 'filled'] as const)('종료 %s 뒤 재개/추가 체결은 차단한다', (state) => {
  const { before, after } = pair();
  before.state = state;
  after.state = 'partial';
  expect(reconcileOrderObservations(before, after)).toMatchObject({
    outcome: 'blocked',
    reasons: ['TERMINAL_CHANGED'],
  });
});
it.each([null, '0.5', '2'])('동일 수량의 늦은 비용/환급 %j를 체결로 만들지 않는다', (commission) => {
  const before = fixture(),
    after = fixture();
  after.observedAt = '2026-11-11T01:00:20.000Z';
  after.execution.commission = commission;
  const r = reconcileOrderObservations(before, after);
  expect(r.outcome).toBe(commission === null ? 'review-required' : 'cost-adjustment');
  expect(r.delta?.quantity).toBe('0');
  expect(r.delta?.commission).toBe(commission === null ? null : commission === '0.5' ? '-0.5' : '1');
  expect(r.canApplyToLedger).toBe(false);
});
it('이전 null 비용이 나중에 알려져도 0으로 간주해 차감하지 않는다', () => {
  const before = fixture(),
    after = fixture();
  before.execution.commission = null;
  after.observedAt = '2026-11-11T01:00:20.000Z';
  expect(reconcileOrderObservations(before, after)).toMatchObject({
    outcome: 'review-required',
    reasons: ['TOTALS_UNKNOWN'],
    delta: { quantity: '0', commission: null },
  });
});
it('첫 체결의 이전 null 금액/비용은 그대로 검토 대상으로 남긴다', () => {
  const { before, after } = pair();
  before.state = 'pending';
  before.execution = {
    quantity: '0',
    averagePrice: null,
    amount: null,
    commission: null,
    tax: null,
    lastFilledAt: null,
    settlementDate: null,
  };
  expect(reconcileOrderObservations(before, after)).toMatchObject({
    outcome: 'review-required',
    reasons: ['TOTALS_UNKNOWN'],
    delta: { quantity: '3', amount: null, commission: null, tax: null },
  });
});
it('체결 증가와 비용 감소가 함께 있으면 별도 검토로 남긴다', () => {
  const { before, after } = pair();
  after.execution.commission = '0.5';
  expect(reconcileOrderObservations(before, after)).toMatchObject({
    outcome: 'review-required',
    reasons: ['COST_CORRECTION_WITH_FILL'],
    delta: { commission: '-0.5' },
  });
});
it.each(['amount', 'averagePrice'] as const)('수량 변화 없는 %s 정정은 신규 체결이 아니다', (field) => {
  const before = fixture(),
    after = fixture();
  after.observedAt = '2026-11-11T01:00:20.000Z';
  after.execution[field] = '101';
  expect(reconcileOrderObservations(before, after)).toMatchObject({
    outcome: 'review-required',
    delta: { quantity: '0' },
  });
});
it('정산일 등 metadata 변경은 금액 증분으로 확대하지 않는다', () => {
  const before = fixture(),
    after = fixture();
  after.observedAt = '2026-11-11T01:00:20.000Z';
  after.execution.settlementDate = '2026-11-13';
  expect(reconcileOrderObservations(before, after)).toMatchObject({
    outcome: 'metadata-change',
    delta: { quantity: '0', amount: '0', commission: '0', tax: '0' },
  });
});
it.each(['unknown', 'change-rejected'] as const)(
  '미지/정정·취소 거부 레코드 %s는 실행 가능한 변화로 만들지 않는다',
  (state) => {
    const { before, after } = pair();
    after.state = state;
    expect(reconcileOrderObservations(before, after).outcome).toBe('review-required');
  },
);
it('금액 기반 주문은 수량 전량 체결을 추정하지 않는다', () => {
  const { before, after } = pair();
  before.definition.amount = '1000';
  after.definition.amount = '1000';
  expect(reconcileOrderObservations(before, after)).toMatchObject({
    outcome: 'review-required',
    reasons: ['AMOUNT_ORDER_UNSUPPORTED'],
  });
});
it('체결 시각 누락/주문 전/조회 이후 시각을 구분한다', () => {
  const { before, after } = pair();
  after.execution.lastFilledAt = null;
  expect(reconcileOrderObservations(before, after)).toMatchObject({
    outcome: 'review-required',
    reasons: ['FILL_TIME_UNKNOWN'],
  });
  after.execution.lastFilledAt = '2026-11-11T02:00:00.000Z';
  expect(reconcileOrderObservations(before, after)).toMatchObject({
    outcome: 'blocked',
    reasons: ['TIMELINE_INVALID'],
  });
});
it('고정밀 누적값 차이의 소수 자릿수를 보존한다', () => {
  const { before, after } = pair();
  before.execution.commission = '0.0000000000000000000000000001';
  after.execution.commission = '0.0000000000000000000000000003';
  expect(reconcileOrderObservations(before, after).delta?.commission).toBe('0.0000000000000000000000000002');
});
it.each([
  null,
  { formatVersion: 'invalid' },
  { scope: 'PRIVATE_SECRET' },
  { execution: { quantity: 'NaN' } },
  { observedAt: '2026-11-11T01:00:20.000001Z' },
  { currency: 'JPY' },
  { extra: 'PRIVATE_SECRET' },
])('외부 입력 %j를 원문 없이 거부한다', (patch) => {
  const input = patch === null ? null : { ...fixture(), ...patch };
  const r = reconcileOrderObservations(fixture(), input);
  expect(r).toMatchObject({ outcome: 'blocked', reasons: ['INPUT_INVALID'], delta: null });
  expect(JSON.stringify(r)).not.toContain('PRIVATE_SECRET');
});

it('명시적으로 알려진 0 기준만 첫 체결의 차액에 사용한다', () => {
  const { before, after } = pair();
  before.state = 'pending';
  before.execution = {
    quantity: '0',
    averagePrice: null,
    amount: '0',
    commission: '0',
    tax: '0',
    lastFilledAt: null,
    settlementDate: null,
  };
  expect(reconcileOrderObservations(before, after)).toMatchObject({
    outcome: 'progress',
    delta: { quantity: '3', amount: '320', commission: '3', tax: '0.3' },
  });
});
it('전량 체결 뒤 비용 확정/환급은 재체결 없이 별도로 검토한다', () => {
  const before = fixture(),
    after = fixture();
  for (const s of [before, after]) {
    s.state = 'filled';
    s.execution.quantity = '5';
    s.execution.amount = '500';
  }
  after.observedAt = '2026-11-11T01:00:20.000Z';
  after.execution.commission = '0.8';
  expect(reconcileOrderObservations(before, after)).toMatchObject({
    outcome: 'cost-adjustment',
    delta: { quantity: '0', amount: '0', commission: '-0.2' },
    canApplyToLedger: false,
  });
});
it('기준 누락을 undefined나 잘못된 객체로 숨기지 않는다', () => {
  for (const value of [undefined, {}, 'PRIVATE_SECRET']) {
    expect(reconcileOrderObservations(value, fixture())).toMatchObject({
      outcome: 'blocked',
      reasons: ['INPUT_INVALID'],
    });
  }
});
it('새 체결량이 늘어도 금액이 늘지 않거나 기존 체결 시각이 사라지면 검토한다', () => {
  const { before, after } = pair();
  after.execution.amount = before.execution.amount;
  expect(reconcileOrderObservations(before, after)).toMatchObject({
    outcome: 'review-required',
    reasons: ['AMOUNT_NOT_INCREASED'],
  });
  const later = fixture();
  later.observedAt = after.observedAt;
  later.execution.lastFilledAt = null;
  expect(reconcileOrderObservations(before, later)).toMatchObject({
    outcome: 'review-required',
    reasons: ['FILL_TIME_UNKNOWN'],
    delta: { quantity: '0' },
  });
});
