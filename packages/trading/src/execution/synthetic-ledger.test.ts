import { expect, it } from 'vitest';
import type { OrderObservation, SyntheticLedgerState, SyntheticOrderBindingInput } from '@hth/contracts';
import {
  initializeSyntheticLedger,
  registerSyntheticLedgerOrder,
  applySyntheticLedgerObservation,
} from './synthetic-ledger.js';
import type { SyntheticLedgerResult } from './synthetic-ledger.js';
import { syntheticBindingFixture, syntheticBindingUuid as uuid } from '../../test/synthetic-binding-fixture.js';
function proof() {
  const p = syntheticBindingFixture();
  p.observation.execution.amount = p.observation.execution.commission = p.observation.execution.tax = '0';
  return p;
}
function stateOf(result: SyntheticLedgerResult) {
  expect(result.outcome).toBe('projected');
  expect(result).toMatchObject({
    ledgerApplied: false,
    ownershipVerified: false,
    evidenceAuthenticated: false,
    canApplyToLedger: false,
    executionEnabled: false,
    canResend: false,
    canResume: false,
  });
  return result.state!;
}
function initial(p = proof(), usd = '2000') {
  return stateOf(
    initializeSyntheticLedger({
      source: 'synthetic-fixture',
      namespace: p.context.namespace,
      scope: p.context.scope,
      cash: { KRW: '100000', USD: usd },
      positions: [{ instrument: p.observation.instrument, manualQuantity: '10' }],
    }),
  );
}
const register = (
  state: SyntheticLedgerState,
  p: SyntheticOrderBindingInput,
  reservedCash = '600',
  reservedQuantity = '0',
) => registerSyntheticLedgerOrder({ source: 'synthetic-fixture', state, proof: p, reservedCash, reservedQuantity });
function observed(
  p: SyntheticOrderBindingInput,
  q: string,
  time = 10,
  amount = (Number(q) * 100).toString(),
  fee = q,
): OrderObservation {
  return {
    ...structuredClone(p.observation),
    observedAt: `2026-11-12T01:00:${time.toString().padStart(2, '0')}.000Z`,
    state: q === p.observation.definition.quantity ? 'filled' : 'partial',
    execution: {
      quantity: q,
      amount,
      commission: fee,
      tax: '0',
      averagePrice: '100',
      lastFilledAt: '2026-11-12T01:00:05.000Z',
      settlementDate: null,
    },
  };
}
const apply = (state: SyntheticLedgerState, p: SyntheticOrderBindingInput, sequence: number, obs: OrderObservation) =>
  applySyntheticLedgerObservation({
    source: 'synthetic-fixture',
    state,
    bindingId: p.candidate!.bindingId,
    sequence,
    observation: obs,
  });
function bought(usd = '2000') {
  const p = proof();
  let state = stateOf(register(initial(p, usd), p, usd === '505' ? '505' : '600'));
  for (const [index, q] of ['2', '3', '5'].entries())
    state = stateOf(apply(state, p, index + 1, observed(p, q, 10 + index)));
  return { p, state };
}
function sellProof(
  original: SyntheticOrderBindingInput,
  size = '3',
  strategyId = original.candidate!.strategy.id,
  id = 10,
) {
  const p = structuredClone(original);
  p.candidate!.bindingId = uuid(id);
  p.candidate!.intentId = p.intent!.intentId = p.attempt!.intentId = p.acknowledgement!.intentId = uuid(id + 1);
  p.candidate!.dedupeKey = p.intent!.dedupeKey = id.toString(16).padStart(64, '0');
  p.candidate!.orderReference = p.acknowledgement!.orderReference = p.observation.orderReference = `fake-sell-${id}`;
  p.candidate!.strategy.id = p.intent!.strategy.id = strategyId;
  p.intent!.request.side = p.observation.side = 'SELL';
  p.intent!.request.definition.quantity = p.observation.definition.quantity = size;
  return p;
}
it('0→2→3→5에서 신규분만 현금/원가/전략 소유량에 반영하고 수동 10주를 보존한다', () => {
  const p = proof();
  let state = stateOf(register(initial(p), p));
  const quantities = [];
  for (const [i, q] of ['2', '3', '5'].entries()) {
    const r = apply(state, p, i + 1, observed(p, q, 10 + i));
    quantities.push(r.effect?.quantity);
    state = stateOf(r);
  }
  expect(quantities).toEqual(['2', '1', '2']);
  expect(state.cash).toEqual({ KRW: '100000', USD: '1495' });
  expect(state.positions[0]).toMatchObject({
    manualQuantity: '10',
    owners: [{ strategyId: p.candidate!.strategy.id, quantity: '5', basis: '505' }],
  });
  expect(state.orders[0]).toMatchObject({ sequence: 3, reservedCash: '0', reservedQuantity: '0' });
});
it('동일/과거/건너뛴 sequence는 적용하지 않고 원래 상태를 변경하지 않는다', () => {
  const { p, state } = bought(),
    before = structuredClone(state);
  for (const sequence of [1, 3, 5])
    expect(apply(state, p, sequence, observed(p, '5', 20)).reason).toBe('SEQUENCE_INVALID');
  expect(state).toEqual(before);
});
it('매도는 자기 전략 원가만 해제하고 대금은 미정산으로 보관한다', () => {
  const { p, state: buy } = bought();
  const sell = sellProof(p);
  let state = stateOf(register(buy, sell, '0', '3'));
  state = stateOf(apply(state, sell, 1, observed(sell, '1', 20, '120', '1')));
  expect(state.positions[0]!.owners[0]).toMatchObject({ quantity: '4', basis: '404' });
  expect(state.realizedPnl.USD).toBe('18');
  state = stateOf(apply(state, sell, 2, observed(sell, '3', 21, '360', '3')));
  expect(state.cash.USD).toBe('1495');
  expect(state.receivables.USD).toBe('357');
  expect(state.realizedPnl.USD).toBe('54');
  expect(state.positions[0]).toMatchObject({ manualQuantity: '10', owners: [{ quantity: '2', basis: '202' }] });
  const last = sellProof(p, '2', p.candidate!.strategy.id, 20);
  state = stateOf(register(state, last, '0', '2'));
  state = stateOf(apply(state, last, 1, observed(last, '2', 22, '240', '2')));
  expect(state.positions[0]).toMatchObject({ manualQuantity: '10', owners: [{ quantity: '0', basis: '0' }] });
  expect(state.realizedPnl.USD).toBe('90');
  expect(state.receivables.USD).toBe('595');
});
it('미정산 매도대금이나 다른 통화 현금을 매수 자금으로 사용하지 않는다', () => {
  const { p, state: buy } = bought('505'),
    sell = sellProof(p, '5');
  let state = stateOf(register(buy, sell, '0', '5'));
  state = stateOf(apply(state, sell, 1, observed(sell, '5', 20, '600', '5')));
  expect(state.cash.USD).toBe('0');
  expect(state.receivables.USD).toBe('595');
  const next = proof();
  next.candidate!.bindingId = uuid(40);
  next.candidate!.intentId = next.intent!.intentId = next.attempt!.intentId = next.acknowledgement!.intentId = uuid(41);
  next.candidate!.dedupeKey = next.intent!.dedupeKey = 'f'.repeat(64);
  next.candidate!.orderReference = next.acknowledgement!.orderReference = next.observation.orderReference = 'next-buy';
  expect(register(state, next, '100').reason).toBe('INSUFFICIENT_CASH');
});
it('수동/타 전략 보유분은 매도 예약에 포함하지 않는다', () => {
  const { p, state } = bought(),
    before = structuredClone(state);
  expect(register(state, sellProof(p, '6'), '0', '6').reason).toBe('INSUFFICIENT_OWNERSHIP');
  expect(register(state, sellProof(p, '1', 'other-strategy'), '0', '1').reason).toBe('INSUFFICIENT_OWNERSHIP');
  expect(state).toEqual(before);
});
it('다른 주문이 예약한 같은 전략 수량을 다시 예약하지 않는다', () => {
  const { p, state } = bought();
  const first = stateOf(register(state, sellProof(p, '3'), '0', '3'));
  expect(register(first, sellProof(p, '3', p.candidate!.strategy.id, 20), '0', '3').reason).toBe(
    'INSUFFICIENT_OWNERSHIP',
  );
  expect(register(first, sellProof(p, '2', p.candidate!.strategy.id, 20), '0', '2').outcome).toBe('projected');
});
it('다른 주문의 현금 예약을 침범하는 등록/체결은 차단한다', () => {
  const p = proof(),
    one = stateOf(register(initial(p, '1000'), p));
  const second = sellProof(p, '5', p.candidate!.strategy.id, 20);
  second.intent!.request.side = second.observation.side = 'BUY';
  expect(register(one, second, '500').reason).toBe('INSUFFICIENT_CASH');
  const both = stateOf(register(one, second, '400'));
  expect(apply(both, p, 1, observed(p, '5', 10, '600', '5')).reason).toBe('INSUFFICIENT_CASH');
  const next = stateOf(apply(both, p, 1, observed(p, '2', 10)));
  expect(next.orders[1]!.reservedCash).toBe('400');
  expect(next.cash.USD).toBe('798');
});
it('부분 체결 후 취소는 기존 수량/원가를 보존하고 잔여 예약만 해제한다', () => {
  const p = proof();
  let state = stateOf(register(initial(p), p));
  const partial = observed(p, '2');
  state = stateOf(apply(state, p, 1, partial));
  const canceled = {
    ...partial,
    observedAt: '2026-11-12T01:00:20.000Z',
    state: 'canceled' as const,
    canceledAt: '2026-11-12T01:00:15.000Z',
  };
  const result = apply(state, p, 2, canceled);
  state = stateOf(result);
  expect(result.effect?.quantity).toBe('0');
  expect(state.cash.USD).toBe('1798');
  expect(state.orders[0]!.reservedCash).toBe('0');
  expect(state.positions[0]!.owners[0]).toMatchObject({ quantity: '2', basis: '202' });
});
it('0효과 재관측도 순서만 진행하고 새 체결이나 수수료를 만들지 않는다', () => {
  const p = proof(),
    state = stateOf(register(initial(p), p));
  const obs = { ...p.observation, observedAt: '2026-11-12T01:00:10.000Z' };
  const next = stateOf(apply(state, p, 1, obs));
  expect(next.cash).toEqual(state.cash);
  expect(next.positions).toEqual(state.positions);
  expect(next.orders[0]!.sequence).toBe(1);
});
it('평균가를 체결 금액이나 개별 체결가로 재구성하지 않는다', () => {
  const p = proof(),
    state = stateOf(register(initial(p), p)),
    obs = observed(p, '2', 10, '201', '2');
  obs.execution.averagePrice = '100.499999999999999';
  const r = apply(state, p, 1, obs);
  expect(stateOf(r).positions[0]!.owners[0]!.basis).toBe('203');
  expect(r.effect).not.toHaveProperty('price');
});
it('늦은 비용 증가/환급은 매도 후 잔여 원가에 자동 배분하지 않는다', () => {
  const { p, state } = bought();
  for (const commission of ['6', '4']) {
    const obs = { ...structuredClone(state.orders[0]!.observation), observedAt: '2026-11-12T01:00:20.000Z' };
    obs.execution.commission = commission;
    expect(apply(state, p, 4, obs).reason).toBe('COST_REVIEW_REQUIRED');
  }
});
it.each(['amount', 'commission', 'tax'] as const)('null %s 기준을 0으로 추측해서 등록하지 않는다', (field) => {
  const p = proof();
  p.observation.execution[field] = null;
  expect(register(initial(p), p).reason).toBe('BASELINE_REQUIRED');
});
it('첫 부분 체결을 영(0) 기준으로 소급 등록하지 않는다', () => {
  const p = proof();
  p.observation = observed(p, '2');
  expect(register(initial(p), p).reason).toBe('BASELINE_REQUIRED');
});
it.each(['unknown', 'replaced', 'change-rejected'] as const)(
  '지원하지 않는 관측 %s는 상태를 진행하지 않는다',
  (value) => {
    const p = proof(),
      state = stateOf(register(initial(p), p)),
      obs = observed(p, '2');
    obs.state = value;
    expect(apply(state, p, 1, obs).outcome).toBe('blocked');
  },
);
it('체결 증가와 비용 정정이 섞이거나 양이 역행하면 차단한다', () => {
  const p = proof();
  let state = stateOf(register(initial(p), p));
  state = stateOf(apply(state, p, 1, observed(p, '2')));
  expect(apply(state, p, 2, observed(p, '1', 20)).outcome).toBe('blocked');
  expect(apply(state, p, 2, observed(p, '3', 20, '300', '1')).outcome).toBe('blocked');
});
it.each(['scope', 'orderReference'] as const)('관측 %s가 바인딩과 다르면 차단한다', (field) => {
  const p = proof(),
    state = stateOf(register(initial(p), p)),
    obs = observed(p, '2');
  obs[field] = field === 'scope' ? 'f'.repeat(64) : 'other-order';
  expect(apply(state, p, 1, obs).outcome).toBe('blocked');
});
it('USD/KRW 최소 단위보다 정밀한 금액을 몰래 반올림하지 않는다', () => {
  const p = proof(),
    state = stateOf(register(initial(p), p)),
    obs = observed(p, '2');
  obs.execution.commission = '0.001';
  expect(apply(state, p, 1, obs).reason).toBe('AMOUNT_PRECISION_UNSUPPORTED');
  expect(
    initializeSyntheticLedger({
      source: 'synthetic-fixture',
      namespace: p.context.namespace,
      scope: p.context.scope,
      cash: { KRW: '0.1', USD: '0' },
      positions: [],
    }).outcome,
  ).toBe('blocked');
});
it('KRW도 통화를 분리해 같은 계산 규칙을 사용한다', () => {
  const p = proof();
  p.intent!.request.instrument = p.observation.instrument = { market: 'KR', symbol: '005930' };
  p.intent!.request.currency = p.observation.currency = 'KRW';
  let state = stateOf(register(initial(p), p));
  state = stateOf(apply(state, p, 1, observed(p, '5')));
  expect(state.cash).toEqual({ KRW: '99495', USD: '2000' });
});
it('초기 계좌에 전략 소유 수량을 주입하거나 live source를 넣을 수 없다', () => {
  const p = proof();
  const input = {
    source: 'synthetic-fixture',
    namespace: p.context.namespace,
    scope: p.context.scope,
    cash: { KRW: '0', USD: '100' },
    positions: [
      {
        instrument: p.observation.instrument,
        manualQuantity: '10',
        owners: [{ strategyId: 'fake-strategy', quantity: '5', basis: '500' }],
      },
    ],
  };
  expect(initializeSyntheticLedger(input).reason).toBe('INPUT_INVALID');
  expect(initializeSyntheticLedger({ ...input, source: 'live' }).reason).toBe('INPUT_INVALID');
});
it('손상된 version/원가/예약 상태를 정상 입력으로 계산하지 않는다', () => {
  const { p, state } = bought();
  const bad = structuredClone(state);
  bad.version--;
  expect(apply(bad, p, 4, observed(p, '5', 20)).reason).toBe('STATE_INVALID');
  bad.version = state.version;
  bad.positions[0]!.owners[0]!.quantity = '0';
  expect(apply(bad, p, 4, observed(p, '5', 20)).reason).toBe('STATE_INVALID');
});
it('잘못된 입력/중복 등록은 고정 사유만 반환하며 입력을 변경하지 않는다', () => {
  expect(applySyntheticLedgerObservation({ token: 'PRIVATE' }).reason).toBe('INPUT_INVALID');
  const p = proof(),
    state = stateOf(register(initial(p), p)),
    before = structuredClone(state);
  expect(register(state, p).reason).toBe('BINDING_INVALID');
  expect(state).toEqual(before);
});
it('센트 미만의 비례 원가는 부분 매도 시 내리고 마지막 매도에서 잔여 전액을 해제한다', () => {
  const p = proof();
  p.intent!.request.definition.quantity = p.observation.definition.quantity = '3';
  let state = stateOf(register(initial(p), p));
  const buy = observed(p, '3', 10, '0.01', '0');
  buy.execution.averagePrice = '0.003333333333333333';
  state = stateOf(apply(state, p, 1, buy));
  const sell = sellProof(p, '1');
  state = stateOf(register(state, sell, '0', '1'));
  const first = apply(state, sell, 1, observed(sell, '1', 20, '0.01', '0'));
  state = stateOf(first);
  expect(first.effect?.releasedBasis).toBe('0');
  const last = sellProof(p, '2', p.candidate!.strategy.id, 20);
  state = stateOf(register(state, last, '0', '2'));
  const final = apply(state, last, 1, observed(last, '2', 21, '0.02', '0'));
  state = stateOf(final);
  expect(final.effect?.releasedBasis).toBe('0.01');
  expect(state.positions[0]!.owners[0]).toMatchObject({ quantity: '0', basis: '0' });
});
it('순서가 다른 같은 주문/신호를 새 UUID로 등록해 이중 계산할 수 없다', () => {
  const p = proof(),
    state = stateOf(register(initial(p), p)),
    other = structuredClone(p);
  other.candidate!.bindingId = uuid(50);
  other.candidate!.intentId =
    other.intent!.intentId =
    other.attempt!.intentId =
    other.acknowledgement!.intentId =
      uuid(51);
  expect(register(state, other).reason).toBe('BINDING_INVALID');
});
it('512개 0효과 적용 후 새 주문의 첫 적용으로 전체 한도를 우회하지 못한다', () => {
  const p = proof();
  let state = stateOf(register(initial(p), p));
  for (let i = 1; i <= 512; i++) {
    const observation = {
      ...p.observation,
      observedAt: new Date(Date.parse(p.observation.observedAt) + i * 1000).toISOString(),
    };
    state = stateOf(apply(state, p, i, observation));
  }
  const second = sellProof(p, '5', p.candidate!.strategy.id, 20);
  second.intent!.request.side = second.observation.side = 'BUY';
  state = stateOf(register(state, second));
  expect(apply(state, second, 1, observed(second, '1', 20)).reason).toBe('LIMIT');
});
