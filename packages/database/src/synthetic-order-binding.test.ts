import { expect, it, vi } from 'vitest';
import type { createDatabase } from './index.js';
import { createSyntheticOrderBindingStore } from './synthetic-order-binding.js';
import { syntheticBindingFixture, syntheticBindingEvidence } from '../test/synthetic-binding-fixtures.js';
const url = 'postgres://hth_test:fake@127.0.0.1:63000/hth_readonly_test';
function fakeDatabase(connectionString = url) {
  const transaction = vi.fn();
  const database = { db: { $client: { options: { connectionString } }, transaction } } as unknown as ReturnType<
    typeof createDatabase
  >;
  return { database, transaction };
}
it.each([
  'postgres://hth_test:PRIVATE@remote/hth_readonly_test',
  'postgres://business:PRIVATE@localhost/business',
  'not-a-url',
])('안전하지 않은 DB URL은 I/O 전에 거부한다', (value) => {
  const f = fakeDatabase();
  expect(() => createSyntheticOrderBindingStore(f.database, value)).toThrow('ORDER_BINDING_DATABASE_INVALID');
  expect(f.transaction).not.toHaveBeenCalled();
});
it('실제 pool URL이 검증 대상과 다르면 거부한다', () => {
  const f = fakeDatabase(url.replace('63000', '63001'));
  expect(() => createSyntheticOrderBindingStore(f.database, url)).toThrow('ORDER_BINDING_DATABASE_INVALID');
});
it.each(['live', 'toss-readonly', 'synthetic', ''])('가짜 source 이외 %s 초기화는 연결하지 않는다', async (source) => {
  const f = fakeDatabase(),
    store = createSyntheticOrderBindingStore(f.database, url),
    input = syntheticBindingFixture();
  await expect(
    store.initialize({ source, namespace: input.context.namespace, scope: input.context.scope }),
  ).rejects.toThrow('ORDER_BINDING_INPUT_INVALID');
  expect(f.transaction).not.toHaveBeenCalled();
});
it('record에 intent/registry를 넣어 DB 대신 주장할 수 없다', async () => {
  const f = fakeDatabase(),
    store = createSyntheticOrderBindingStore(f.database, url),
    input = syntheticBindingFixture();
  const command = {
    source: 'synthetic-fixture',
    operationId: input.candidate!.bindingId,
    expectedVersion: 0,
    expectedStateHash: 'a'.repeat(64),
    evidence: syntheticBindingEvidence(input),
  };
  for (const extra of [{ intent: input.intent }, { registry: input.registry }]) {
    await expect(store.record({ ...command, evidence: { ...command.evidence, ...extra } })).rejects.toThrow(
      'ORDER_BINDING_INPUT_INVALID',
    );
  }
  expect(f.transaction).not.toHaveBeenCalled();
});
it('잘못된 read/seed/명령은 DB에 접근하지 않고 원문을 반환하지 않는다', async () => {
  const f = fakeDatabase(),
    store = createSyntheticOrderBindingStore(f.database, url);
  await expect(store.read('PRIVATE_ACCOUNT')).rejects.toThrow('ORDER_BINDING_INPUT_INVALID');
  await expect(store.recordIntent({ token: 'PRIVATE' })).rejects.toThrow('ORDER_BINDING_INPUT_INVALID');
  await expect(store.record({ token: 'PRIVATE' })).rejects.toThrow('ORDER_BINDING_INPUT_INVALID');
  expect(f.transaction).not.toHaveBeenCalled();
});
