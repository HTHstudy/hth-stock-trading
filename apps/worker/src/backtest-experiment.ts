import { z } from 'zod';
import { movingAverageBacktestConfigSchema } from '@hth/contracts';
import { canonicalJson, contentHash } from '@hth/database';
import { createBacktestArtifact, parseDatasetExport } from './backtest-artifact.js';

const name = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
export const experimentManifestSchema = z
  .object({
    formatVersion: z.literal('backtest-experiment-v1'),
    datasets: z
      .array(
        z
          .object({
            id: name,
            path: z.string().trim().min(1).max(4096),
            contentHash: z.string().regex(/^[a-f0-9]{64}$/),
            role: z.enum(['research', 'validation']),
          })
          .strict(),
      )
      .min(1)
      .max(8),
    variants: z
      .array(z.object({ id: name, config: movingAverageBacktestConfigSchema }).strict())
      .min(1)
      .max(8),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.datasets.length * value.variants.length > 32 ||
      new Set(value.datasets.map((item) => item.id)).size !== value.datasets.length ||
      new Set(value.variants.map((item) => item.id)).size !== value.variants.length
    )
      context.addIssue({ code: 'custom', message: 'Duplicate names or too many runs' });
  });

export function parseExperimentManifest(input: unknown) {
  const parsed = experimentManifestSchema.safeParse(input);
  if (!parsed.success) throw new Error('INVALID_EXPERIMENT_MANIFEST');
  return parsed.data;
}

export function runBacktestExperiment(input: unknown, exports: unknown[]) {
  const manifest = parseExperimentManifest(input);
  if (exports.length !== manifest.datasets.length) throw new Error('EXPERIMENT_INPUT_MISMATCH');
  const datasets = exports.map((value, index) => {
    const exported = parseDatasetExport(value);
    if (exported.contentHash !== manifest.datasets[index]!.contentHash) throw new Error('EXPERIMENT_INPUT_MISMATCH');
    return exported;
  });
  const first = datasets[0]!.dataset;
  const identity = (dataset: typeof first) => ({
    instrument: dataset.request.instrument,
    currency: dataset.instrument.currency,
    interval: dataset.request.interval,
    adjusted: dataset.request.adjusted,
    source: dataset.request.source,
  });
  if (datasets.some(({ dataset }) => contentHash(identity(dataset)) !== contentHash(identity(first))))
    throw new Error('EXPERIMENT_INCOMPARABLE_INPUTS');
  const ordered = datasets.map(({ dataset }) => dataset.request).sort((a, b) => a.from.localeCompare(b.from));
  if (ordered.some((request, index) => index > 0 && request.from <= ordered[index - 1]!.to))
    throw new Error('EXPERIMENT_OVERLAPPING_PERIODS');
  if (datasets.reduce((total, { dataset }) => total + dataset.candles.length, 0) * manifest.variants.length > 100_000)
    throw new Error('EXPERIMENT_WORK_LIMIT');
  let reportBytes = 0;
  const runs = datasets.flatMap((exported, index) =>
    manifest.variants.map((variant) => {
      const artifact = createBacktestArtifact({
        dataset: exported.dataset,
        datasetId: exported.id,
        source: 'file',
        config: variant.config,
      });
      reportBytes += Buffer.byteLength(canonicalJson(artifact));
      if (reportBytes > 32 * 1048576) throw new Error('EXPERIMENT_WORK_LIMIT');
      return {
        dataset: manifest.datasets[index]!.id,
        role: manifest.datasets[index]!.role,
        variant: variant.id,
        configHash: contentHash(variant.config),
        config: variant.config,
        tradePathObserved: artifact.report.fills.length > 0,
        artifact,
      };
    }),
  );
  const payload = {
    formatVersion: 'backtest-experiment-result-v1' as const,
    mode: 'paper' as const,
    executionEnabled: false as const,
    pointInTime: false as const,
    manifestHash: contentHash(manifest),
    inputs: datasets.map((exported, index) => ({
      id: manifest.datasets[index]!.id,
      role: manifest.datasets[index]!.role,
      artifactId: exported.id,
      contentHash: exported.contentHash,
      request: exported.dataset.request,
    })),
    runs,
  };
  return { resultHash: contentHash(payload), ...payload };
}
