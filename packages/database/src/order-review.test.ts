import { expect, it, vi } from 'vitest';
import type { createDatabase } from './index.js';
import { createSyntheticOrderReviewStore } from './order-review.js';
import { reviewFixture } from '../test/order-review-fixtures.js';
const url = 'postgresql://hth_test:fake@127.0.0.1:63346/hth_readonly_test';
function fakeDatabase(connectionString = url) {
  const transaction = vi.fn();
  const database = { db: { $client: { options: { connectionString } }, transaction } } as unknown as ReturnType<
    typeof createDatabase
  >;
  return { database, transaction };
}
it.each([
  'postgresql://hth_test:PRIVATE@remote/hth_readonly_test',
  'postgresql://hth:PRIVATE@127.0.0.1/hth_trading',
  'not-a-url',
])('일반/외부/잘못된 DB 주소는 연결 전에 거부한다', (value) => {
  const f = fakeDatabase();
  expect(() => createSyntheticOrderReviewStore(f.database, value)).toThrow('ORDER_REVIEW_DATABASE_INVALID');
  expect(f.transaction).not.toHaveBeenCalled();
});
it('검증용 URL과 실제 pool URL이 다르면 연결 전에 거부한다', () => {
  const f = fakeDatabase('postgresql://hth_test:fake@127.0.0.1:63347/hth_readonly_test');
  expect(() => createSyntheticOrderReviewStore(f.database, url)).toThrow('ORDER_REVIEW_DATABASE_INVALID');
  expect(f.transaction).not.toHaveBeenCalled();
});
it.each(['toss-readonly', 'live', 'synthetic', ''])('합성 source 이외 %s는 DB 작업 전에 거부한다', async (source) => {
  const f = fakeDatabase(),
    store = createSyntheticOrderReviewStore(f.database, url);
  await expect(store.initialize({ ...reviewFixture(), source })).rejects.toThrow('ORDER_REVIEW_INPUT_INVALID');
  expect(f.transaction).not.toHaveBeenCalled();
});
it.each(['quantity', 'amount', 'commission', 'tax'] as const)(
  '0 기준이 아닌 %s 초기 상태를 DB 작업 전에 거부한다',
  async (key) => {
    const f = fakeDatabase(),
      store = createSyntheticOrderReviewStore(f.database, url),
      fixture = reviewFixture();
    if (key === 'quantity') fixture.observation.execution.quantity = '1';
    else fixture.observation.execution[key] = null;
    await expect(store.initialize(fixture)).rejects.toThrow('ORDER_REVIEW_BASELINE_INVALID');
    expect(f.transaction).not.toHaveBeenCalled();
  },
);
it('잘못된 record/read 입력은 원문/자격을 출력하거나 DB에 접근하지 않는다', async () => {
  const f = fakeDatabase(),
    store = createSyntheticOrderReviewStore(f.database, url);
  await expect(store.record({ source: 'PRIVATE_SECRET' })).rejects.toThrow('ORDER_REVIEW_INPUT_INVALID');
  await expect(store.read('PRIVATE_SECRET')).rejects.toThrow('ORDER_REVIEW_INPUT_INVALID');
  expect(f.transaction).not.toHaveBeenCalled();
});
