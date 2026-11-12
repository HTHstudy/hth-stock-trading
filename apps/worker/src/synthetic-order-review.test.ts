import { expect, it, vi } from 'vitest';
import { createSyntheticOrderReviewSession } from './synthetic-order-review.js';
import type { SyntheticOrderReviewCommand } from './synthetic-order-review.js';
const id = '3b52f32e-3c68-42d7-9bc7-138956c16322';
const config = { source: 'synthetic-fixture', streamId: id, maxOperations: 2 };
function fixture() {
  const store = {
    read: vi.fn().mockResolvedValue({ status: 'ready' }),
    record: vi.fn().mockResolvedValue({ replayed: false, receipt: { outcome: 'checkpoint-advanced' } }),
  };
  const source = { next: vi.fn().mockResolvedValue(null), close: vi.fn().mockResolvedValue(undefined) };
  // Unit ports deliberately implement only the fields read by the harness; integration uses the real store.
  const session = createSyntheticOrderReviewSession(
    store as unknown as Parameters<typeof createSyntheticOrderReviewSession>[0],
    source,
  );
  return { store, source, session };
}
function command(): SyntheticOrderReviewCommand {
  return {
    source: 'synthetic-fixture',
    streamId: id,
    operationId: '6e3625de-0300-42ad-b19f-dc6240b72d1b',
    expectedVersion: 0,
    expectedObservationHash: 'a'.repeat(64),
    observation: {
      formatVersion: 'order-observation-v1',
      scope: 'b'.repeat(64),
      orderReference: 'fixture',
      observedAt: '2026-11-12T01:00:01.000Z',
      instrument: { market: 'US', symbol: 'AAPL' },
      currency: 'USD',
      side: 'BUY',
      definition: {
        type: 'limit',
        validity: 'day',
        quantity: '5',
        limitPrice: '110',
        orderedAt: '2026-11-12T01:00:00.000Z',
      },
      state: 'pending',
      execution: {
        quantity: '0',
        amount: '0',
        commission: '0',
        tax: '0',
        averagePrice: null,
        lastFilledAt: null,
        settlementDate: null,
      },
    },
  };
}
it('잘못된 설정은 I/O 없이 거부하고 세션을 소비하지 않는다', async () => {
  const { session, store, source } = fixture();
  for (const input of [
    { ...config, source: 'live' },
    { ...config, maxOperations: 61 },
    { ...config, maxOperations: 0 },
  ]) {
    await expect(session.run(input)).rejects.toThrow('SYNTHETIC_ORDER_REVIEW_INPUT_INVALID');
  }
  expect(store.read).not.toHaveBeenCalled();
  expect(source.close).not.toHaveBeenCalled();
  expect((await session.run(config)).outcome).toBe('completed');
});
it('사전 취소는 source/DB를 읽지 않지만 소유 source를 한 번 정리한다', async () => {
  const { session, store, source } = fixture();
  expect(await session.run(config, AbortSignal.abort())).toMatchObject({
    outcome: 'canceled',
    attempted: 0,
    cleanupSucceeded: true,
  });
  expect(store.read).not.toHaveBeenCalled();
  expect(source.next).not.toHaveBeenCalled();
  expect(source.close).toHaveBeenCalledTimes(1);
});
it('보류된 저장 기준으로는 source를 읽거나 새 기록을 만들지 않는다', async () => {
  const { session, store, source } = fixture();
  store.read.mockResolvedValue({ status: 'quarantined' });
  expect((await session.run(config)).outcome).toBe('held');
  expect(source.next).not.toHaveBeenCalled();
  expect(store.record).not.toHaveBeenCalled();
});
it('다른 stream 명령과 잘못된 입력은 저장 전에 종료한다', async () => {
  for (const raw of [{ ...command(), streamId: 'fe82c92a-1627-4c67-8932-366134f5b42a' }, { private: 'secret' }]) {
    const { session, store, source } = fixture();
    source.next.mockResolvedValue(raw);
    expect(await session.run(config)).toMatchObject({ outcome: 'failed', reason: 'command-invalid', attempted: 0 });
    expect(store.record).not.toHaveBeenCalled();
    expect(source.close).toHaveBeenCalledTimes(1);
  }
});
it('원래 작업 ID/기대 기준을 유지하고 replay를 신규 커밋으로 세지 않는다', async () => {
  const { session, store, source } = fixture();
  const original = command();
  source.next.mockResolvedValueOnce(original);
  store.record.mockResolvedValue({ replayed: true, receipt: { outcome: 'checkpoint-advanced' } });
  expect(await session.run({ ...config, maxOperations: 1 })).toMatchObject({
    outcome: 'limit-reached',
    attempted: 1,
    committed: 0,
    replayed: 1,
    checkpointConfirmed: true,
  });
  expect(store.record).toHaveBeenCalledExactlyOnceWith(original);
  expect(store.read).toHaveBeenCalledTimes(2);
  expect(source.next).toHaveBeenCalledTimes(1);
});
it('source 대기 중 취소하면 돌아온 명령을 저장하지 않는다', async () => {
  const { session, store, source } = fixture();
  const controller = new AbortController();
  source.next.mockImplementation(async () => {
    controller.abort();
    return command();
  });
  expect((await session.run(config, controller.signal)).outcome).toBe('canceled');
  expect(store.record).not.toHaveBeenCalled();
});
it('기록 중 취소해도 기록과 현재 기준 확인을 마친 뒤 정리한다', async () => {
  const { session, store, source } = fixture();
  const controller = new AbortController(),
    order: string[] = [];
  source.next.mockResolvedValue(command());
  store.record.mockImplementation(async () => {
    controller.abort();
    expect(source.close).not.toHaveBeenCalled();
    await Promise.resolve();
    order.push('record-settled');
    return { replayed: false, receipt: { outcome: 'checkpoint-advanced' } };
  });
  source.close.mockImplementation(async () => {
    order.push('closed');
  });
  expect(await session.run(config, controller.signal)).toMatchObject({
    outcome: 'canceled',
    committed: 1,
    checkpointConfirmed: true,
    recordOutcomeUncertain: false,
  });
  expect(order).toEqual(['record-settled', 'closed']);
  expect(source.next).toHaveBeenCalledTimes(1);
});
it('저장 응답 실패는 불확실로 남기고 자동 재시도하지 않는다', async () => {
  const { session, store, source } = fixture();
  source.next.mockResolvedValue(command());
  store.record.mockRejectedValue(new Error('PRIVATE_DATABASE_DETAIL'));
  const result = await session.run(config);
  expect(result).toMatchObject({
    outcome: 'failed',
    reason: 'record-failed',
    attempted: 1,
    committed: 0,
    checkpointConfirmed: false,
    recordOutcomeUncertain: true,
  });
  expect(JSON.stringify(result)).not.toContain('PRIVATE_DATABASE_DETAIL');
  expect(store.record).toHaveBeenCalledTimes(1);
  expect(source.next).toHaveBeenCalledTimes(1);
});
it('기록 후 기준 조회 실패를 미커밋으로 표시하지 않는다', async () => {
  const { session, store, source } = fixture();
  source.next.mockResolvedValue(command());
  store.read.mockResolvedValueOnce({ status: 'ready' }).mockRejectedValue(new Error('PRIVATE'));
  expect(await session.run(config)).toMatchObject({
    outcome: 'failed',
    reason: 'checkpoint-read-failed',
    committed: 1,
    checkpointConfirmed: false,
    recordOutcomeUncertain: false,
  });
});
it('충돌은 현재 기준을 다시 확인해도 자동으로 고쳐 제출하지 않는다', async () => {
  const { session, store, source } = fixture();
  source.next.mockResolvedValue(command());
  store.record.mockResolvedValue({ replayed: false, receipt: { outcome: 'conflict' } });
  expect((await session.run(config)).outcome).toBe('conflict');
  expect(store.record).toHaveBeenCalledTimes(1);
});
it('source 읽기/정리 오류 원문을 반환하지 않는다', async () => {
  const { session, source } = fixture();
  source.next.mockRejectedValue(new Error('PRIVATE_SOURCE'));
  source.close.mockRejectedValue(new Error('PRIVATE_CLOSE'));
  const result = await session.run(config);
  expect(result).toMatchObject({ outcome: 'failed', reason: 'cleanup-failed', cleanupSucceeded: false });
  expect(JSON.stringify(result)).not.toContain('PRIVATE');
});
it('완료한 세션을 다시 쓰거나 동시에 실행하지 못한다', async () => {
  const { session, source } = fixture();
  const first = session.run(config);
  await expect(session.run(config)).rejects.toThrow('SYNTHETIC_ORDER_REVIEW_SESSION_CONSUMED');
  await first;
  await expect(session.run(config)).rejects.toThrow('SYNTHETIC_ORDER_REVIEW_SESSION_CONSUMED');
  expect(source.close).toHaveBeenCalledTimes(1);
});
it('최초 기준 확인 실패는 source를 시작하지 않고 종료한다', async () => {
  const { session, store, source } = fixture();
  store.read.mockRejectedValue(new Error('PRIVATE_READ'));
  expect(await session.run(config)).toMatchObject({
    outcome: 'failed',
    reason: 'checkpoint-read-failed',
    attempted: 0,
    checkpointConfirmed: false,
    cleanupSucceeded: true,
  });
  expect(source.next).not.toHaveBeenCalled();
});
it('source 실패는 자동 재시도 없이 정리하며 고정 코드만 남긴다', async () => {
  const { session, store, source } = fixture();
  source.next.mockRejectedValue(new Error('PRIVATE_SOURCE'));
  expect(await session.run(config)).toMatchObject({
    outcome: 'failed',
    reason: 'source-read-failed',
    attempted: 0,
    cleanupSucceeded: true,
  });
  expect(source.next).toHaveBeenCalledTimes(1);
  expect(store.record).not.toHaveBeenCalled();
});
it('완료 직전 정리 실패를 정상 완료로 반환하지 않는다', async () => {
  const { session, source } = fixture();
  source.close.mockRejectedValue(new Error('PRIVATE_CLOSE'));
  expect(await session.run(config)).toMatchObject({
    outcome: 'failed',
    reason: 'cleanup-failed',
    cleanupSucceeded: false,
  });
});
it('source 조회 완료는 주문 권한이나 원장 적용을 부여하지 않는다', async () => {
  const { session } = fixture();
  expect(await session.run(config)).toMatchObject({
    outcome: 'completed',
    ledgerApplied: false,
    canApplyToLedger: false,
    ownershipVerified: false,
    executionEnabled: false,
    canResend: false,
    canResume: false,
  });
});
