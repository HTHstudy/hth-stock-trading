import { expect, it, vi } from 'vitest';
import { parsePaperPreparation, runPaperPreparation } from './paper-preparation.js';

const plan = 'examples/paper-market-us-validation-v1.json';
it('기본 미리보기는 키·DB가 없어도 실행하며 DB factory와 마이그레이션을 호출하지 않는다', async () => {
  const openDatabase = vi.fn(() => {
    throw new Error('NO_DATABASE_ALLOWED');
  });
  const assertDatabase = vi.fn();
  const migrate = vi.fn();
  const report = await runPaperPreparation(
    ['--plan=' + plan],
    { PAPER_MARKET_DATABASE_URL: 'invalid', TOSS_CLIENT_SECRET: 'do-not-use' },
    { openDatabase, assertDatabase, migrate },
  );
  expect(report).toMatchObject({
    state: 'preview',
    canResume: false,
    executionEnabled: false,
    marketReadiness: 'not-checked',
    market: 'US',
  });
  expect(openDatabase).not.toHaveBeenCalled();
  expect(assertDatabase).not.toHaveBeenCalled();
  expect(migrate).not.toHaveBeenCalled();
});
it('변경된 계획 hash는 DB 연결·마이그레이션 전에 차단한다', async () => {
  const openDatabase = vi.fn(() => {
    throw new Error('DATABASE_MUST_NOT_OPEN');
  });
  const assertDatabase = vi.fn();
  const migrate = vi.fn();
  await expect(
    runPaperPreparation(
      ['--plan=' + plan, '--plan-hash=' + '0'.repeat(64), '--account=paper-market-test', '--apply', '--migrate'],
      {},
      { openDatabase, assertDatabase, migrate },
    ),
  ).rejects.toThrow('PAPER_MARKET_PLAN_HASH_MISMATCH');
  expect(openDatabase).not.toHaveBeenCalled();
  expect(assertDatabase).not.toHaveBeenCalled();
  expect(migrate).not.toHaveBeenCalled();
});
it('재개·기존 계좌형식·조회 마이그레이션·상충 옵션을 거부한다', () => {
  for (const flags of [
    ['--resume'],
    ['--apply', '--check'],
    ['--migrate'],
    ['--check', '--migrate'],
    ['--account=paper-demo-test', '--apply'],
    ['--apply'],
    ['--plan-hash=invalid'],
  ])
    expect(() => parsePaperPreparation(['--plan=' + plan, ...flags])).toThrow();
});
it('live 모드를 DB 연결 전에 거부한다', async () => {
  await expect(runPaperPreparation(['--plan=' + plan], { TRADING_MODE: 'live' })).rejects.toThrow();
});
