import { expect, it } from 'vitest';
import { syntheticOrderBindingReviewSchema } from '@hth/contracts';
import type { SyntheticOrderBindingInput } from '@hth/contracts';
import { reviewSyntheticOrderBinding } from './synthetic-order-binding.js';
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
function fixture(): SyntheticOrderBindingInput {
  const namespace = { brokerId: 'fake-broker', environment: 'synthetic-fixture' as const, accountId: uuid(1) };
  const strategy = { id: 'fake-strategy', revision: 3, definitionHash: 'b'.repeat(64) };
  return structuredClone({
    formatVersion: 'synthetic-order-binding-input-v1',
    source: 'synthetic-fixture',
    context: { namespace: { ...namespace }, scope: 'a'.repeat(64), connectionGeneration: 1 },
    candidate: {
      bindingId: uuid(2),
      namespace: { ...namespace },
      intentId: uuid(3),
      strategy: { ...strategy },
      requestHash: 'c'.repeat(64),
      dedupeKey: 'd'.repeat(64),
      orderReference: 'fake-order',
    },
    intent: {
      namespace: { ...namespace },
      intentId: uuid(3),
      strategy: { ...strategy },
      requestHash: 'c'.repeat(64),
      dedupeKey: 'd'.repeat(64),
      recordedAt: '2026-11-12T01:00:00.000Z',
      request: {
        instrument: { market: 'US', symbol: 'AAPL' },
        currency: 'USD',
        side: 'BUY',
        definition: { type: 'limit', validity: 'day', quantity: '5', limitPrice: '110', amount: null },
      },
    },
    attempt: {
      namespace: { ...namespace },
      attemptId: uuid(4),
      intentId: uuid(3),
      requestHash: 'c'.repeat(64),
      originGeneration: 1,
      recordedAt: '2026-11-12T01:00:01.000Z',
    },
    acknowledgement: {
      kind: 'synthetic-acceptance',
      namespace: { ...namespace },
      attemptId: uuid(4),
      intentId: uuid(3),
      requestHash: 'c'.repeat(64),
      originGeneration: 1,
      orderReference: 'fake-order',
      receivedAt: '2026-11-12T01:00:03.000Z',
    },
    observationNamespace: { ...namespace },
    observation: {
      formatVersion: 'order-observation-v1',
      scope: 'a'.repeat(64),
      orderReference: 'fake-order',
      observedAt: '2026-11-12T01:00:04.000Z',
      instrument: { market: 'US', symbol: 'AAPL' },
      currency: 'USD',
      side: 'BUY',
      definition: {
        type: 'limit',
        validity: 'day',
        quantity: '5',
        limitPrice: '110',
        amount: null,
        orderedAt: '2026-11-12T01:00:02.000Z',
      },
      state: 'pending',
      execution: {
        quantity: '0',
        amount: null,
        commission: null,
        tax: null,
        averagePrice: null,
        lastFilledAt: null,
        settlementDate: null,
      },
    },
    registry: { complete: true, bindings: [] },
  });
}
function review(input: unknown) {
  const result = reviewSyntheticOrderBinding(input);
  expect(syntheticOrderBindingReviewSchema.safeParse(result).success).toBe(true);
  for (const key of [
    'bindingPersisted',
    'evidenceAuthenticated',
    'financialBaselineEstablished',
    'ledgerApplied',
    'canApplyToLedger',
    'ownershipVerified',
    'executionEnabled',
    'canResend',
    'canResume',
  ] as const)
    expect(result[key]).toBe(false);
  expect(result).not.toHaveProperty('bindingId');
  expect(result).not.toHaveProperty('accountId');
  return result;
}
it('가짜 연결의 일관성만 판정하며 입력과 null 금액/비용을 변경하지 않는다', () => {
  const input = fixture(),
    before = structuredClone(input);
  expect(review(input)).toMatchObject({ outcome: 'consistent-synthetic-binding', reasons: [] });
  expect(input).toEqual(before);
});
it('이미 같은 영구 키/내용으로 연결된 가짜 주문은 unchanged다', () => {
  const input = fixture();
  input.registry.bindings.push(structuredClone(input.candidate!));
  expect(review(input)).toMatchObject({ outcome: 'unchanged-synthetic-binding', reasons: [] });
});
it('경제적으로 같은 십진 표기와 같은 instant의 다른 offset을 허용한다', () => {
  const input = fixture();
  input.observation.definition.quantity = '5.000';
  input.observation.definition.limitPrice = '110.00';
  input.intent!.recordedAt = '2026-11-12T10:00:00.000+09:00';
  expect(review(input).outcome).toBe('consistent-synthetic-binding');
});
it('재연결 세대가 바뀌어도 과거 접수 근거와 영구 namespace를 바꾸지 않는다', () => {
  const input = fixture();
  input.context.connectionGeneration = 2;
  input.registry.bindings.push(structuredClone(input.candidate!));
  expect(review(input).outcome).toBe('unchanged-synthetic-binding');
  expect(input.acknowledgement!.originGeneration).toBe(1);
  expect(input.candidate!.strategy.revision).toBe(3);
});
it('KRW 종목과 매도 방향의 일치도 실제 매도/수량 권한을 부여하지 않는다', () => {
  const input = fixture();
  for (const request of [input.intent!.request, input.observation]) {
    request.instrument = { market: 'KR', symbol: '005930' };
    request.currency = 'KRW';
    request.side = 'SELL';
  }
  expect(review(input).outcome).toBe('consistent-synthetic-binding');
});
it.each(['candidate', 'intent', 'attempt', 'acknowledgement'] as const)(
  '%s가 없으면 주문 내용이 같아도 소유 전략으로 편입하지 않는다',
  (key) => {
    const input = fixture();
    input[key] = null;
    expect(review(input).outcome).toBe('unassigned');
  },
);
it.each(['synthetic-uncertain', 'synthetic-unattributed'] as const)(
  '접수 근거 %s는 일치하는 종목/수량으로 보완하지 않는다',
  (kind) => {
    const input = fixture();
    input.acknowledgement!.kind = kind;
    expect(review(input).outcome).toBe('unassigned');
  },
);
it.each(['candidate', 'intent', 'attempt', 'acknowledgement'] as const)('%s의 다른 계좌는 차단한다', (key) => {
  const input = fixture();
  input[key]!.namespace.accountId = uuid(100);
  expect(review(input).reasons).toContain('NAMESPACE_MISMATCH');
});
it('관측의 계좌 문맥과 broker가 다르면 scope 문자열이 같아도 차단한다', () => {
  const input = fixture();
  input.observationNamespace.brokerId = 'other-broker';
  expect(review(input).reasons).toContain('NAMESPACE_MISMATCH');
});
it('관측 scope가 다르면 거부한다', () => {
  const input = fixture();
  input.observation.scope = 'f'.repeat(64);
  expect(review(input).reasons).toContain('SCOPE_MISMATCH');
});
it.each(['candidate', 'attempt', 'acknowledgement'] as const)('%s의 다른 의도는 차단한다', (key) => {
  const input = fixture();
  input[key]!.intentId = uuid(100);
  expect(review(input).reasons).toContain('INTENT_MISMATCH');
});
it.each(['id', 'revision', 'definitionHash'] as const)('연결 대상 전략 %s가 원래 의도와 다르면 차단한다', (key) => {
  const input = fixture();
  const owner = input.candidate!.strategy;
  if (key === 'id') owner.id = 'other-strategy';
  if (key === 'revision') owner.revision++;
  if (key === 'definitionHash') owner.definitionHash = 'f'.repeat(64);
  expect(review(input).reasons).toContain('STRATEGY_MISMATCH');
});
it.each(['candidate', 'attempt', 'acknowledgement'] as const)('%s의 요청 hash 변경은 차단한다', (key) => {
  const input = fixture();
  input[key]!.requestHash = 'f'.repeat(64);
  expect(review(input).reasons).toContain('REQUEST_HASH_MISMATCH');
});
it('신호 영구 키를 바꾼 후보는 차단한다', () => {
  const input = fixture();
  input.candidate!.dedupeKey = 'f'.repeat(64);
  expect(review(input).reasons).toContain('DEDUPE_KEY_MISMATCH');
});
it('접수의 attempt ID와 출처 세대가 다르면 차단한다', () => {
  const input = fixture();
  input.acknowledgement!.attemptId = uuid(100);
  input.acknowledgement!.originGeneration++;
  expect(review(input).reasons).toEqual(expect.arrayContaining(['ATTEMPT_MISMATCH', 'ORIGIN_MISMATCH']));
});
it.each(['candidate', 'acknowledgement', 'observation'] as const)('%s의 주문 참조 변경은 차단한다', (key) => {
  const input = fixture();
  input[key]!.orderReference = 'other-order';
  expect(review(input).reasons).toContain('ORDER_REFERENCE_MISMATCH');
});
it.each(['symbol', 'market', 'side', 'quantity', 'price', 'type', 'validity'] as const)(
  'hash가 같아도 실제 요청 %s가 다르면 차단한다',
  (key) => {
    const input = fixture(),
      observed = input.observation;
    if (key === 'symbol') observed.instrument.symbol = 'MSFT';
    if (key === 'market') {
      observed.instrument.market = 'KR';
      observed.currency = 'KRW';
    }
    if (key === 'side') observed.side = 'SELL';
    if (key === 'quantity') observed.definition.quantity = '6';
    if (key === 'price') observed.definition.limitPrice = '111';
    if (key === 'type') observed.definition.type = 'market';
    if (key === 'validity') observed.definition.validity = 'closing';
    expect(review(input).reasons).toContain('REQUEST_MISMATCH');
  },
);
it('optional의 부재와 null을 동일한 값으로 만들지 않는다', () => {
  const input = fixture();
  delete input.observation.definition.amount;
  expect(review(input).reasons).toContain('REQUEST_MISMATCH');
  delete input.intent!.request.definition.amount;
  expect(review(input).outcome).toBe('consistent-synthetic-binding');
});
it.each([
  'zero-quantity',
  'unknown-type',
  'unknown-validity',
  'amount-order',
  'missing-limit',
  'zero-limit',
  'market-with-limit',
] as const)('지원하지 않는 요청 %s는 차단한다', (kind) => {
  const input = fixture(),
    d = input.intent!.request.definition;
  if (kind === 'zero-quantity') d.quantity = '0';
  if (kind === 'unknown-type') d.type = 'unknown';
  if (kind === 'unknown-validity') d.validity = 'unknown';
  if (kind === 'amount-order') d.amount = '550';
  if (kind === 'missing-limit') d.limitPrice = null;
  if (kind === 'zero-limit') d.limitPrice = '0';
  if (kind === 'market-with-limit') d.type = 'market';
  expect(review(input).reasons).toContain('REQUEST_UNSUPPORTED');
});
it.each(['unknown', 'change-rejected'] as const)('관측 %s는 체결/원주문 거절 상태로 추정하지 않는다', (state) => {
  const input = fixture();
  input.observation.state = state;
  expect(review(input).reasons).toContain('OBSERVATION_UNSUPPORTED');
});
it('시장가의 명시적 null 지정가는 일치하는 가짜 정의로 비교한다', () => {
  const input = fixture();
  for (const d of [input.intent!.request.definition, input.observation.definition]) {
    d.type = 'market';
    d.limitPrice = null;
  }
  expect(review(input).outcome).toBe('consistent-synthetic-binding');
});
it('첫 관측이 이미 부분 체결이어도 영(0) 금융 기준이나 기존 보유분을 생성하지 않는다', () => {
  const input = fixture();
  input.observation.state = 'partial';
  input.observation.execution = {
    ...input.observation.execution,
    quantity: '2',
    amount: '200',
    commission: '2',
    tax: '0',
    averagePrice: '100',
    lastFilledAt: '2026-11-12T01:00:02.000Z',
  };
  expect(review(input)).toMatchObject({ outcome: 'consistent-synthetic-binding', financialBaselineEstablished: false });
});
it.each(['intent', 'attempt', 'order', 'acknowledgement'] as const)(
  '근거의 시각 순서 %s가 역전되면 차단한다',
  (key) => {
    const input = fixture();
    if (key === 'intent') input.intent!.recordedAt = '2026-11-12T01:00:02.000Z';
    if (key === 'attempt') input.attempt!.recordedAt = '2026-11-12T01:00:03.000Z';
    if (key === 'order') input.observation.definition.orderedAt = '2026-11-12T01:00:04.000Z';
    if (key === 'acknowledgement') input.acknowledgement!.receivedAt = '2026-11-12T01:00:05.000Z';
    expect(review(input).reasons).toContain('TIMELINE_INVALID');
  },
);
it('불완전한 기존 연결 목록을 빈 정상 목록으로 간주하지 않는다', () => {
  const input = fixture();
  input.registry.complete = false;
  expect(review(input).reasons).toContain('REGISTRY_INCOMPLETE');
});
it('같은 영구 의도/주문을 새 binding UUID로 다시 연결할 수 없다', () => {
  const input = fixture();
  const old = structuredClone(input.candidate!);
  old.bindingId = uuid(100);
  input.registry.bindings.push(old);
  expect(review(input).reasons).toEqual(expect.arrayContaining(['INTENT_ALREADY_BOUND', 'ORDER_ALREADY_BOUND']));
});
it('기존 binding UUID의 내용과 계좌를 바꿔 재사용할 수 없다', () => {
  const input = fixture();
  const old = structuredClone(input.candidate!);
  old.namespace.accountId = uuid(100);
  input.registry.bindings.push(old);
  expect(review(input).reasons).toContain('BINDING_ID_REUSED');
});
it.each(['binding', 'intent', 'order', 'signal'] as const)('기존 목록 자체의 %s 중복도 차단한다', (key) => {
  const input = fixture(),
    first = structuredClone(input.candidate!),
    second = structuredClone(input.candidate!);
  first.bindingId = uuid(100);
  first.intentId = uuid(101);
  first.orderReference = 'other-1';
  first.dedupeKey = 'e'.repeat(64);
  second.bindingId = uuid(102);
  second.intentId = uuid(103);
  second.orderReference = 'other-2';
  second.dedupeKey = 'f'.repeat(64);
  if (key === 'binding') second.bindingId = first.bindingId;
  if (key === 'intent') second.intentId = first.intentId;
  if (key === 'order') second.orderReference = first.orderReference;
  if (key === 'signal') second.dedupeKey = first.dedupeKey;
  input.registry.bindings.push(first, second);
  expect(review(input).reasons).toContain('REGISTRY_CONFLICT');
});
it('다른 계좌의 같은 주문 문자열은 별도 namespace이며 현재 계좌의 중복으로 보지 않는다', () => {
  const input = fixture(),
    other = structuredClone(input.candidate!);
  other.bindingId = uuid(100);
  other.namespace.accountId = uuid(101);
  input.registry.bindings.push(other);
  expect(review(input).outcome).toBe('consistent-synthetic-binding');
});
it('같은 계좌/주문을 다른 의도/전략으로 연결하려 해도 차단한다', () => {
  const input = fixture(),
    other = structuredClone(input.candidate!);
  other.bindingId = uuid(100);
  other.intentId = uuid(101);
  other.strategy.id = 'other-strategy';
  input.registry.bindings.push(other);
  expect(review(input).reasons).toContain('ORDER_ALREADY_BOUND');
});
it('모든 가짜 hash/접수 라벨이 같아도 실제 인증이나 소유권 증명이 되지는 않는다', () => {
  const input = fixture();
  for (const record of [input.intent!, input.candidate!, input.attempt!, input.acknowledgement!])
    record.requestHash = '0'.repeat(64);
  expect(review(input)).toMatchObject({
    outcome: 'consistent-synthetic-binding',
    evidenceAuthenticated: false,
    ownershipVerified: false,
  });
});
it.each([undefined, null, {}, { source: 'live' }])('외부 입력 오류는 고정 코드만 반환한다 %#', (input) => {
  expect(review(input)).toMatchObject({ outcome: 'blocked', reasons: ['INPUT_INVALID'] });
});
it('실제 source/추가 권한 필드/손상 hash/목록 상한 초과는 계약에서 차단한다', () => {
  const input = fixture();
  for (const bad of [
    { ...input, source: 'toss-readonly' },
    { ...input, ownershipVerified: true },
    { ...input, context: { ...input.context, token: 'PRIVATE_SECRET' } },
    { ...input, candidate: { ...input.candidate, requestHash: 'bad' } },
    { ...input, registry: { complete: true, bindings: Array.from({ length: 257 }, () => input.candidate) } },
  ]) {
    const result = review(bad);
    expect(result.reasons).toEqual(['INPUT_INVALID']);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_SECRET');
  }
});
it('동일 신호를 다른 의도와 주문 문자열로 바꿔 재연결할 수 없다', () => {
  const input = fixture(),
    old = structuredClone(input.candidate!);
  old.bindingId = uuid(100);
  old.intentId = uuid(101);
  old.orderReference = 'other-order';
  input.registry.bindings.push(old);
  expect(review(input).reasons).toContain('SIGNAL_ALREADY_BOUND');
});
it.each(['attemptId', 'intentId', 'requestHash'] as const)(
  '가짜 acceptance도 %s가 null이면 연결 근거가 완비된 것으로 보지 않는다',
  (key) => {
    const input = fixture();
    input.acknowledgement![key] = null;
    expect(review(input).outcome).toBe('blocked');
  },
);
it('차단 결과에 불일치 원본/전략/주문 식별자를 되돌려 보내지 않는다', () => {
  const input = fixture();
  input.candidate!.orderReference = 'PRIVATE_ORDER_REFERENCE';
  const result = review(input);
  expect(result.outcome).toBe('blocked');
  expect(JSON.stringify(result)).not.toContain('PRIVATE_ORDER_REFERENCE');
});
it('도메인이 지원하지 않는 고정밀 시각을 잘라서 순서를 비교하지 않는다', () => {
  const input = fixture();
  input.intent!.recordedAt = '2026-11-12T01:00:00.000001Z';
  expect(review(input).reasons).toEqual(['INPUT_INVALID']);
});
it('UUID의 대소문자로 계좌 namespace와 기존 binding 키를 우회하지 못한다', () => {
  const input = fixture();
  const accountId = uuid(0xabcdef),
    bindingId = uuid(0xaabbcc);
  for (const n of [
    input.context.namespace,
    input.candidate!.namespace,
    input.intent!.namespace,
    input.attempt!.namespace,
    input.acknowledgement!.namespace,
    input.observationNamespace,
  ])
    n.accountId = accountId;
  input.candidate!.bindingId = bindingId;
  input.registry.bindings.push(structuredClone(input.candidate!));
  input.candidate!.bindingId = bindingId.toUpperCase();
  input.candidate!.namespace.accountId = accountId.toUpperCase();
  expect(review(input).outcome).toBe('unchanged-synthetic-binding');
});
