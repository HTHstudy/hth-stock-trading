import { expect, it } from 'vitest';
import type { BrokerOrder } from '@hth/broker';
import { reconcileOrderObservations } from '@hth/trading';
import { toOrderObservation } from './order-observation.js';
const order = (): BrokerOrder => ({
  reference: 'fake-order',
  instrument: { market: 'US', symbol: 'AAPL' },
  side: 'BUY',
  type: { value: 'LIMIT', known: true },
  validity: { value: 'DAY', known: true },
  status: { value: 'PARTIAL_FILLED', known: true },
  currency: 'USD',
  requestedQuantity: '5',
  limitPrice: '110',
  requestedAmount: null,
  orderedAt: '2026-11-11T01:00:00.000Z',
  execution: {
    quantity: '1',
    averagePrice: '100',
    amount: '100',
    commission: '1',
    tax: '0',
    lastFilledAt: '2026-11-11T01:00:01.000Z',
    settlementDate: null,
  },
});
const context = { scope: 'a'.repeat(64), observedAt: '2026-11-11T01:00:10.000Z' };
it('서버 scope와 broker 조회를 연결하되 계좌/전략 소유를 추정하지 않는다', () => {
  const input = order();
  const before = toOrderObservation(input, context);
  const after = toOrderObservation(
    { ...input, execution: { ...input.execution, quantity: '2', amount: '201', commission: '2' } },
    { ...context, observedAt: '2026-11-11T01:00:20.000Z' },
  );
  expect(reconcileOrderObservations(before, after)).toMatchObject({
    outcome: 'progress',
    delta: { quantity: '1', amount: '101', commission: '1', tax: '0' },
    ownershipVerified: false,
    canApplyToLedger: false,
  });
  expect(before).not.toHaveProperty('strategyId');
  expect(input).toEqual(order());
});
it.each(['CANCEL_REJECTED', 'REPLACE_REJECTED'])(
  '%s는 원주문의 거부 상태가 아닌 별도 변경 거부로 분류한다',
  (value) => {
    const o = order();
    const changed = { ...o, status: { ...o.status, value } };
    expect(toOrderObservation(changed, context).state).toBe('change-rejected');
  },
);
it.each(['FUTURE', 'constructor', '__proto__'])('unknown code %s는 prototype 참조 없이 unknown으로 남긴다', (value) => {
  const o = {
    ...order(),
    type: { value, known: true },
    validity: { value, known: true },
    status: { value, known: true },
  };
  const r = toOrderObservation(o, context);
  expect(r.state).toBe('unknown');
  expect(r.definition.type).toBe('unknown');
  expect(r.definition.validity).toBe('unknown');
});
it('known=false를 known 문자열만 보고 승격하지 않는다', () => {
  const o = order();
  const r = toOrderObservation({ ...o, status: { value: 'FILLED', known: false } }, context);
  expect(r.state).toBe('unknown');
});
it.each([{ scope: 'PRIVATE_ACCOUNT' }, { observedAt: 'not-a-date' }])(
  '잘못된 서버 context는 고정 오류로 거부한다 %j',
  (patch) => {
    expect(() => toOrderObservation(order(), { ...context, ...patch })).toThrow('ORDER_OBSERVATION_INVALID');
  },
);
