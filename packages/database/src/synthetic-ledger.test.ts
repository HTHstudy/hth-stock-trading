import { expect, it, vi } from 'vitest';
import type { createDatabase } from './index.js';
import { createSyntheticLedgerStore } from './synthetic-ledger.js';
const url = 'postgres://hth_test:fake@127.0.0.1:60000/hth_readonly_test';
function fake(connectionString = url) {
  const transaction = vi.fn();
  return {
    transaction,
    database: { db: { $client: { options: { connectionString } }, transaction } } as unknown as ReturnType<
      typeof createDatabase
    >,
  };
}
it('일반/외부 DB는 금융 factory 생성 전에 거부한다', () => {
  const f = fake();
  expect(() => createSyntheticLedgerStore(f.database, 'postgres://business:PRIVATE@remote/business')).toThrow(
    'ORDER_BINDING_DATABASE_INVALID',
  );
  expect(f.transaction).not.toHaveBeenCalled();
});
it('실제 pool과 다른 URL은 거부한다', () => {
  const f = fake(url.replace('60000', '60001'));
  expect(() => createSyntheticLedgerStore(f.database, url)).toThrow('ORDER_BINDING_DATABASE_INVALID');
});
it('합성 이외 초기화는 I/O 전에 거부한다', async () => {
  const f = fake(),
    store = createSyntheticLedgerStore(f.database, url);
  await expect(store.initialize({ source: 'live', token: 'PRIVATE' })).rejects.toThrow(
    'SYNTHETIC_LEDGER_INPUT_INVALID',
  );
  expect(f.transaction).not.toHaveBeenCalled();
});
it('잘못된 read/register/observe/apply는 원문 없이 DB 연결 전에 거부한다', async () => {
  const f = fake(),
    store = createSyntheticLedgerStore(f.database, url);
  for (const action of [
    () => store.read('PRIVATE'),
    () => store.register({ token: 'PRIVATE' }),
    () => store.observe({ source: 'live' }),
    () => store.apply({ source: 'live' }),
  ])
    await expect(action()).rejects.toThrow('SYNTHETIC_LEDGER_INPUT_INVALID');
  expect(f.transaction).not.toHaveBeenCalled();
});
