import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { contentHash } from '@hth/database';
import {
  defaultPaperMarketPlan,
  paperMarketPlanSchema,
  readPaperMarketPlan,
  verifyPaperMarketPlan,
} from './paper-market-plan.js';

it('KR/US 계획의 출처·전략 버전·통화와 변경 감지를 확인한다', async () => {
  for (const market of ['kr', 'us']) {
    const plan = await readPaperMarketPlan(
      new URL(`../../../examples/paper-market-${market}-plan.json`, import.meta.url).pathname,
    );
    expect(plan.strategy.instrument.market).toBe(market.toUpperCase());
    expect(await readPaperMarketPlan(`examples/paper-market-${market}-plan.json`)).toEqual(plan);
    expect(verifyPaperMarketPlan(plan, contentHash(plan))).toEqual(plan);
    const changed = structuredClone(plan);
    changed.strategy.quantity = '2';
    expect(() => verifyPaperMarketPlan(changed, contentHash(plan))).toThrow('PAPER_MARKET_PLAN_HASH_MISMATCH');
  }
});
it('실제 주문·다른 출처·알 수 없는 정보·현금 단위·수집 불가능 기간을 거부한다', () => {
  const plan = defaultPaperMarketPlan({ market: 'KR', symbol: '005930' });
  for (const patch of [
    { mode: 'live' },
    { source: 'synthetic-only' },
    { executionEnabled: true },
    { clientSecret: 'do-not-accept' },
    { strategyVersion: 'future' },
    { cash: { KRW: '1.1', USD: '0' } },
    { cash: { KRW: '0', USD: '1000' } },
    { cash: { KRW: '100', USD: '0.001' } },
    { strategy: { ...plan.strategy, parameters: { fastPeriod: 5, slowPeriod: 200 } } },
    { strategy: { ...plan.strategy, maxFillQuantity: '2' } },
  ])
    expect(paperMarketPlanSchema.safeParse({ ...plan, ...patch }).success).toBe(false);
});
it('계획은 작은 일반 파일만 읽고 오류에 원문과 경로를 포함하지 않는다', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paper-market-plan-'));
  try {
    const path = join(directory, 'plan.json');
    await writeFile(path, 'PRIVATE_RAW_VALUE');
    await expect(readPaperMarketPlan(path)).rejects.toThrow(/^PAPER_MARKET_PLAN_INVALID$/);
    await writeFile(path, ' '.repeat(65537));
    await expect(readPaperMarketPlan(path)).rejects.toThrow(/^PAPER_MARKET_PLAN_INVALID$/);
    await expect(readPaperMarketPlan(directory)).rejects.toThrow(/^PAPER_MARKET_PLAN_INVALID$/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
