import { expect, it } from 'vitest';
import { durableOrderIntentSchema, durableOrderResultSchema } from '@hth/contracts';
import type { DurableOrderIntent } from '@hth/contracts';
import { initialOrderAttemptState, evolveOrderAttempt } from './order-attempt.js';
const at = '2026-11-18T01:00:00.000Z',
  hash = 'a'.repeat(64);
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const intent: DurableOrderIntent = {
  intentId: id(1),
  signalId: id(2),
  strategyId: id(3),
  strategyRevision: 1,
  request: {
    profile: 'limit-day-integer-v1',
    clientOrderId: id(4),
    instrument: { market: 'KR', symbol: '005930' },
    side: 'BUY',
    quantity: '5',
    limitPrice: '70000',
  },
  expiresAt: '2026-11-18T01:10:00.000Z',
  internalOpening: { quantity: '0', amount: '0', commission: '0', tax: '0' },
};
const claim = {
  kind: 'attempt',
  intentId: id(1),
  attemptId: id(6),
  intentHash: hash,
  ownerId: id(5),
  epoch: 1,
} as const;
function prepared() {
  return evolveOrderAttempt(
    evolveOrderAttempt(initialOrderAttemptState(), { kind: 'intent', intent }, at, hash),
    { kind: 'open', ownerId: id(5) },
    at,
  );
}
it('기본 정지에서 시작하며 호출자의 원본을 변경하지 않는다', () => {
  const initial = initialOrderAttemptState();
  expect(initial).toMatchObject({ paused: true, epoch: 0, ownerId: null });
  expect(() => evolveOrderAttempt(initial, claim, at)).toThrow('ORDER_ATTEMPT_FENCED');
  expect(initial).toEqual(initialOrderAttemptState());
});
it('원래 의도 hash와 새 단일 시도만 연결한다', () => {
  const before = prepared();
  expect(() => evolveOrderAttempt(before, { ...claim, intentHash: 'b'.repeat(64) }, at)).toThrow(
    'ORDER_ATTEMPT_INTENT_MISMATCH',
  );
  const after = evolveOrderAttempt(before, claim, at);
  expect(after.attempts).toHaveLength(1);
  expect(after.intents[0]!.intent.internalOpening).toEqual({ quantity: '0', amount: '0', commission: '0', tax: '0' });
  expect(before.attempts).toHaveLength(0);
  expect(() => evolveOrderAttempt(after, claim, at)).toThrow('ORDER_ATTEMPT_ALREADY_CLAIMED');
});
it.each([
  { ...claim, ownerId: id(8) },
  { ...claim, epoch: 0 },
])('소유자/epoch가 다르면 거부한다 %#', (data) => {
  expect(() => evolveOrderAttempt(prepared(), data, at)).toThrow('ORDER_ATTEMPT_FENCED');
});
it('만료된 lease와 정지 이전 소유자는 heartbeat/전송하지 못한다', () => {
  const before = prepared();
  expect(() => evolveOrderAttempt(before, claim, '2026-11-18T01:00:30.000Z')).toThrow('ORDER_ATTEMPT_FENCED');
  const stopped = evolveOrderAttempt(before, { kind: 'pause' }, at);
  expect(() => evolveOrderAttempt(stopped, { kind: 'heartbeat', ownerId: id(5), epoch: 1 }, at)).toThrow(
    'ORDER_ATTEMPT_FENCED',
  );
  const next = evolveOrderAttempt(stopped, { kind: 'open', ownerId: id(8) }, at);
  expect(next).toMatchObject({ epoch: 3, ownerId: id(8) });
  expect(() => evolveOrderAttempt(next, claim, at)).toThrow('ORDER_ATTEMPT_FENCED');
});
it('살아 있는 다른 lease를 교체하지 않고 heartbeat는 기한만 연장한다', () => {
  const state = prepared();
  expect(() => evolveOrderAttempt(state, { kind: 'open', ownerId: id(8) }, at)).toThrow('ORDER_ATTEMPT_LEASE_BUSY');
  expect(
    evolveOrderAttempt(state, { kind: 'heartbeat', ownerId: id(5), epoch: 1 }, '2026-11-18T01:00:10.000Z'),
  ).toMatchObject({ leaseUntil: '2026-11-18T01:00:40.000Z', epoch: 1 });
});
it('만료된 의도와 15분을 넘는 등록 기한을 거부한다', () => {
  expect(() => evolveOrderAttempt(prepared(), claim, '2026-11-18T01:10:00.000Z')).toThrow();
  for (const expiresAt of [at, '2026-11-18T01:15:00.001Z'])
    expect(() =>
      evolveOrderAttempt(initialOrderAttemptState(), { kind: 'intent', intent: { ...intent, expiresAt } }, at, hash),
    ).toThrow('ORDER_ATTEMPT_INTENT_EXPIRED');
});
it('수동/타 전략 잔고를 opening으로 주입하거나 가격 표기를 바꾸지 못한다', () => {
  for (const changed of [
    { ...intent, internalOpening: { ...intent.internalOpening, quantity: '1' } },
    { ...intent, request: { ...intent.request, quantity: '05' } },
    { ...intent, request: { ...intent.request, limitPrice: '70000.0' } },
  ])
    expect(durableOrderIntentSchema.safeParse(changed).success).toBe(false);
});
it('정지 뒤 원래 접수 근거는 보존하지만 체결이나 재개로 확대하지 않는다', () => {
  const attempted = evolveOrderAttempt(prepared(), claim, at),
    paused = evolveOrderAttempt(attempted, { kind: 'pause' }, at);
  const result = {
    mode: 'mock',
    executionEnabled: false,
    ownershipVerified: false,
    canApplyToLedger: false,
    canResend: false,
    replayed: false,
    clientOrderId: id(4),
    outcome: 'acknowledged',
    reference: 'mock-order',
    status: 200,
  } as const;
  const after = evolveOrderAttempt(paused, { kind: 'result', attemptId: id(6), result }, at);
  expect(after.paused).toBe(true);
  expect(after.attempts[0]!.result?.outcome).toBe('acknowledged');
  expect(() => evolveOrderAttempt(after, { kind: 'result', attemptId: id(6), result }, at)).toThrow(
    'ORDER_ATTEMPT_RESULT_CONFLICT',
  );
  expect(durableOrderResultSchema.safeParse({ ...result, executionEnabled: true }).success).toBe(false);
});
it('재사용한 세션 응답과 다른 client key를 새 전송 결과로 기록하지 않는다', () => {
  const state = evolveOrderAttempt(prepared(), claim, at);
  const result = {
    mode: 'mock',
    executionEnabled: false,
    ownershipVerified: false,
    canApplyToLedger: false,
    canResend: false,
    replayed: false,
    clientOrderId: id(4),
    outcome: 'unknown',
    code: 'TIMEOUT',
    status: null,
  } as const;
  for (const changed of [
    { ...result, replayed: true },
    { ...result, clientOrderId: id(8) },
  ])
    expect(() => evolveOrderAttempt(state, { kind: 'result', attemptId: id(6), result: changed }, at)).toThrow(
      'ORDER_ATTEMPT_RESULT_CONFLICT',
    );
});
it('접수/미확인/미전송 결과가 있어도 새 key로 후속 전송을 우회하지 않는다', () => {
  const other = { ...intent, intentId: id(9), signalId: id(10), request: { ...intent.request, clientOrderId: id(11) } };
  let state = evolveOrderAttempt(prepared(), { kind: 'intent', intent: other }, at, 'b'.repeat(64));
  state = evolveOrderAttempt(state, claim, at);
  expect(() =>
    evolveOrderAttempt(state, { ...claim, intentId: id(9), intentHash: 'b'.repeat(64), attemptId: id(12) }, at),
  ).toThrow('ORDER_ATTEMPT_REVIEW_REQUIRED');
});
