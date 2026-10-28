import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { contentHash } from '@hth/database';
import { createBacktestDemo } from './backtest-demo.js';
import { createBacktestArtifact, parseDatasetExport } from './backtest-artifact.js';

const config = {
  strategy: { fastPeriod: 3, slowPeriod: 5 },
  execution: {
    initialCash: '1000000',
    quantity: '10',
    priceTick: '1',
    buyFeeBps: '10',
    sellFeeBps: '10',
    sellTaxBps: '20',
    slippageBps: '5',
  },
};
it('외부 입력의 schema와 hash를 검증하며 변조된 export를 거부한다', () => {
  const dataset = createBacktestDemo();
  const exported = { id: randomUUID(), contentHash: contentHash(dataset), dataset };
  expect(parseDatasetExport(exported).dataset).toEqual(dataset);
  expect(() => parseDatasetExport({ ...exported, contentHash: '0'.repeat(64) })).toThrow('DATASET_INTEGRITY_FAILED');
  expect(() => parseDatasetExport({ ...exported, account: 'not-allowed' })).toThrow('DATASET_INTEGRITY_FAILED');
});
it('키·계좌 없이 합성 데이터의 결과와 재현성 hash를 생성한다', () => {
  const input = { dataset: createBacktestDemo(), datasetId: null, source: 'synthetic-demo' as const, config };
  const artifact = createBacktestArtifact(input);
  expect(artifact.report.mode).toBe('paper');
  expect(artifact.report.executionEnabled).toBe(false);
  expect(artifact.report.metrics.tradeCount).toBeGreaterThan(0);
  expect(artifact.reportHash).toBe(createBacktestArtifact(input).reportHash);
  const { reportHash, ...payload } = artifact;
  expect(contentHash(payload)).toBe(reportHash);
  expect(() =>
    createBacktestArtifact({
      ...input,
      config: { ...config, execution: { ...config.execution, sellFeeBps: undefined } },
    }),
  ).toThrow('INVALID_BACKTEST_CONFIG');
});
