import { z } from 'zod';
import { backtestArtifactSchema, historicalRequestSchema, movingAverageBacktestConfigSchema } from '@hth/contracts';
import { contentHash } from '@hth/database';
import { compareBacktestCosts } from './backtest-cost-comparison.js';
import { parseExperimentManifest } from './backtest-experiment.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const resultSchema = z
  .object({
    formatVersion: z.literal('backtest-experiment-result-v1'),
    resultHash: hash,
    mode: z.literal('paper'),
    executionEnabled: z.literal(false),
    pointInTime: z.literal(false),
    manifestHash: hash,
    inputs: z
      .array(
        z
          .object({
            id: z.string(),
            role: z.enum(['research', 'validation']),
            artifactId: z.uuid(),
            contentHash: hash,
            request: historicalRequestSchema,
          })
          .strict(),
      )
      .min(1)
      .max(8),
    runs: z
      .array(
        z
          .object({
            dataset: z.string(),
            role: z.enum(['research', 'validation']),
            variant: z.string(),
            configHash: hash,
            config: movingAverageBacktestConfigSchema,
            tradePathObserved: z.boolean(),
            artifact: backtestArtifactSchema,
          })
          .strict(),
      )
      .min(1)
      .max(32),
  })
  .strict();

export function reviewBacktestExperiment(input: unknown, manifestInput: unknown) {
  const manifest = parseExperimentManifest(manifestInput);
  const parsed = resultSchema.safeParse(input);
  if (!parsed.success) throw new Error('EXPERIMENT_RESULT_INVALID');
  const { resultHash, ...payload } = parsed.data;
  const fail = () => {
    throw new Error('EXPERIMENT_RESULT_INVALID');
  };
  if (
    contentHash(payload) !== resultHash ||
    payload.manifestHash !== contentHash(manifest) ||
    payload.inputs.length !== manifest.datasets.length ||
    payload.runs.length !== manifest.datasets.length * manifest.variants.length
  )
    fail();
  const pairs = new Set<string>();
  const inputs = new Map(payload.inputs.map((entry) => [entry.id, entry]));
  if (inputs.size !== payload.inputs.length) fail();
  for (const entry of manifest.datasets) {
    const recorded = inputs.get(entry.id);
    if (!recorded || recorded.role !== entry.role || recorded.contentHash !== entry.contentHash) fail();
  }
  for (const run of payload.runs) {
    const recorded = inputs.get(run.dataset);
    const variant = manifest.variants.find((entry) => entry.id === run.variant);
    const pair = `${run.dataset}/${run.variant}`;
    const { reportHash, ...artifact } = run.artifact;
    if (
      !recorded ||
      !variant ||
      pairs.has(pair) ||
      run.role !== recorded.role ||
      run.configHash !== contentHash(variant.config) ||
      contentHash(run.config) !== run.configHash ||
      contentHash(artifact.report.strategy.parameters) !== contentHash(variant.config.strategy) ||
      contentHash(artifact.report.config) !== contentHash(variant.config.execution) ||
      contentHash(artifact.report.datasetRequest) !== contentHash(recorded.request) ||
      artifact.dataset.source !== 'file' ||
      artifact.dataset.id !== recorded.artifactId ||
      artifact.dataset.contentHash !== recorded.contentHash ||
      contentHash(artifact) !== reportHash ||
      run.tradePathObserved !== artifact.report.fills.length > 0
    )
      fail();
    pairs.add(pair);
  }
  const rows = payload.runs.map((run) => ({
    dataset: run.dataset,
    role: run.role,
    variant: run.variant,
    currency: run.artifact.report.currency,
    request: run.artifact.report.datasetRequest,
    config: run.config,
    configHash: run.configHash,
    reportHash: run.artifact.reportHash,
    tradePathObserved: run.tradePathObserved,
    unfilledAtEnd: run.artifact.report.signals.filter((signal) => signal.status === 'UNFILLED_END').length,
    metrics: run.artifact.report.metrics,
  }));
  return {
    formatVersion: 'backtest-experiment-review-v2',
    resultHash,
    manifestHash: payload.manifestHash,
    artifactIntegrityVerified: true,
    datasetFilesReverified: false,
    engineReexecuted: false,
    pointInTime: false,
    strategySelected: false,
    executionEnabled: false,
    rows,
    costComparisons: compareBacktestCosts(rows),
  };
}
