import { z } from 'zod';
import { historicalDatasetSchema, movingAverageBacktestConfigSchema } from '@hth/contracts';
import type { HistoricalDataset } from '@hth/contracts';
import { contentHash } from '@hth/database';
import { movingAverageCross, runBacktest } from '@hth/trading';

const datasetExportSchema = z
  .object({ id: z.uuid(), contentHash: z.string().regex(/^[a-f0-9]{64}$/), dataset: historicalDatasetSchema })
  .strict();

export function parseDatasetExport(value: unknown) {
  const parsed = datasetExportSchema.safeParse(value);
  if (!parsed.success || contentHash(parsed.data.dataset) !== parsed.data.contentHash)
    throw new Error('DATASET_INTEGRITY_FAILED');
  return parsed.data;
}

export function createBacktestArtifact(input: {
  dataset: HistoricalDataset;
  datasetId: string | null;
  source: 'synthetic-demo' | 'file' | 'database';
  config: unknown;
}) {
  const parsed = movingAverageBacktestConfigSchema.safeParse(input.config);
  if (!parsed.success) throw new Error('INVALID_BACKTEST_CONFIG');
  const report = runBacktest({
    dataset: input.dataset,
    strategy: movingAverageCross,
    strategyConfig: parsed.data.strategy,
    config: parsed.data.execution,
  });
  const artifact = {
    formatVersion: 'backtest-artifact-v1',
    dataset: { id: input.datasetId, contentHash: contentHash(input.dataset), source: input.source },
    report,
  };
  return { reportHash: contentHash(artifact), ...artifact };
}
