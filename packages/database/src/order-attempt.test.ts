import { expect, it, vi } from 'vitest';
import type { createDatabase } from './index.js';
import { createOrderAttemptTestStore } from './order-attempt.js';
import { orderAttemptFixture } from '../test/order-attempt-fixtures.js';
const url = 'postgres://hth_test:fake@127.0.0.1:63000/hth_readonly_test';
function fixture(connectionString = url) {
  const transaction = vi.fn();
  return {
    transaction,
    database: { db: { $client: { options: { connectionString } }, transaction } } as unknown as ReturnType<
      typeof createDatabase
    >,
  };
}
it.each([
  'postgres://hth_test:PRIVATE@remote/hth_readonly_test',
  'postgres://business:PRIVATE@localhost/business',
  'invalid-url',
])('전용이 아닌 DB %s는 I/O 전에 거부한다', (value) => {
  const f = fixture();
  expect(() => createOrderAttemptTestStore(f.database, value)).toThrow('ORDER_ATTEMPT_DATABASE_INVALID');
  expect(f.transaction).not.toHaveBeenCalled();
});
it('실제 pool과 다른 URL을 거부한다', () => {
  expect(() => createOrderAttemptTestStore(fixture(url.replace('63000', '63001')).database, url)).toThrow(
    'ORDER_ATTEMPT_DATABASE_INVALID',
  );
});
it.each(['live', 'paper', 'toss-readonly', 'synthetic-fixture'])(
  '테스트 출처 외 %s는 I/O 전에 차단한다',
  async (source) => {
    const f = fixture(),
      store = createOrderAttemptTestStore(f.database, url);
    await expect(store.initialize({ ...orderAttemptFixture().context, source })).rejects.toThrow(
      'ORDER_ATTEMPT_INPUT_INVALID',
    );
    expect(f.transaction).not.toHaveBeenCalled();
  },
);
it('조회/명령의 외부 입력은 원문 없이 거부한다', async () => {
  const f = fixture(),
    store = createOrderAttemptTestStore(f.database, url);
  await expect(store.read('PRIVATE')).rejects.toThrow('ORDER_ATTEMPT_INPUT_INVALID');
  await expect(store.record(orderAttemptFixture().context.accountId, { token: 'PRIVATE' })).rejects.toThrow(
    'ORDER_ATTEMPT_INPUT_INVALID',
  );
  expect(f.transaction).not.toHaveBeenCalled();
});
