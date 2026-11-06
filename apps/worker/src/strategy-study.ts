import { z } from 'zod';
import {
  backtestArtifactSchema,
  backtestConfigSchema,
  createBacktestReportSchema,
  channelBreakoutConfigSchema,
  historicalRequestSchema,
  meanReversionConfigSchema,
  movingAverageConfigSchema,
} from '@hth/contracts';
import { canonicalJson, contentHash } from '@hth/database';
import { channelBreakout, meanReversion, movingAverageCross, runBacktest } from '@hth/trading';
import type { BacktestConfig, HistoricalDataset } from '@hth/contracts';
import { experimentManifestSchema, prepareExperimentInputs } from './backtest-experiment.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const name = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const strategySchema = z.discriminatedUnion('id', [
  z
    .object({
      id: z.literal('moving-average-cross'),
      version: z.literal('1.0.0'),
      parameters: movingAverageConfigSchema,
    })
    .strict(),
  z
    .object({ id: z.literal('channel-breakout'), version: z.literal('1.0.0'), parameters: channelBreakoutConfigSchema })
    .strict(),
  z
    .object({ id: z.literal('mean-reversion'), version: z.literal('1.0.0'), parameters: meanReversionConfigSchema })
    .strict(),
]);
const reportSchema = createBacktestReportSchema(strategySchema);
const artifactSchema = z
  .object({
    formatVersion: z.literal('strategy-study-artifact-v1'),
    reportHash: hash,
    dataset: backtestArtifactSchema.shape.dataset,
    report: reportSchema,
  })
  .strict();
const variantSchema = z.object({ id: name, strategy: strategySchema, execution: backtestConfigSchema }).strict();
export const strategyStudyManifestSchema = z
  .object({
    formatVersion: z.literal('strategy-study-v1'),
    purpose: z.literal('exploratory-comparison'),
    datasets: z
      .array(experimentManifestSchema.shape.datasets.element.extend({ request: historicalRequestSchema }))
      .min(1)
      .max(8),
    variants: z.array(variantSchema).min(1).max(8),
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

export function parseStrategyStudyManifest(input: unknown) {
  const parsed = strategyStudyManifestSchema.safeParse(input);
  if (!parsed.success) throw new Error('INVALID_STRATEGY_STUDY_MANIFEST');
  return parsed.data;
}

function simulate(dataset: HistoricalDataset, definition: z.infer<typeof strategySchema>, config: BacktestConfig) {
  const input = { dataset, config };
  switch (definition.id) {
    case 'moving-average-cross':
      return runBacktest({ ...input, strategy: movingAverageCross, strategyConfig: definition.parameters });
    case 'channel-breakout':
      return runBacktest({ ...input, strategy: channelBreakout, strategyConfig: definition.parameters });
    case 'mean-reversion':
      return runBacktest({ ...input, strategy: meanReversion, strategyConfig: definition.parameters });
  }
}

const resultSchema = z
  .object({
    formatVersion: z.literal('strategy-study-result-v1'),
    resultHash: hash,
    manifestHash: hash,
    mode: z.literal('paper'),
    executionEnabled: z.literal(false),
    pointInTime: z.literal(false),
    independentHoldoutVerified: z.literal(false),
    strategySelected: z.literal(false),
    inputs: z
      .array(
        z
          .object({
            id: name,
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
            dataset: name,
            variant: name,
            configHash: hash,
            artifact: artifactSchema,
            tradePathObserved: z.boolean(),
          })
          .strict(),
      )
      .min(1)
      .max(32),
  })
  .strict();

export function runStrategyStudy(input: unknown, exports: unknown[]) {
  const manifest = parseStrategyStudyManifest(input);
  const datasets = prepareExperimentInputs(manifest, exports);
  if (
    datasets.some(
      (entry, index) => contentHash(entry.dataset.request) !== contentHash(manifest.datasets[index]!.request),
    )
  )
    throw new Error('EXPERIMENT_INPUT_MISMATCH');
  if (datasets.reduce((total, { dataset }) => total + dataset.candles.length, 0) * manifest.variants.length > 100_000)
    throw new Error('EXPERIMENT_WORK_LIMIT');
  let reportBytes = 0;
  const runs = datasets.flatMap((exported, index) =>
    manifest.variants.map((variant) => {
      const report = reportSchema.parse(simulate(exported.dataset, variant.strategy, variant.execution));
      const payload = {
        formatVersion: 'strategy-study-artifact-v1' as const,
        dataset: { id: exported.id, contentHash: exported.contentHash, source: 'file' as const },
        report,
      };
      const artifact = { reportHash: contentHash(payload), ...payload };
      reportBytes += Buffer.byteLength(canonicalJson(artifact));
      if (reportBytes > 32 * 1048576) throw new Error('EXPERIMENT_WORK_LIMIT');
      return {
        dataset: manifest.datasets[index]!.id,
        variant: variant.id,
        configHash: contentHash({ strategy: variant.strategy, execution: variant.execution }),
        artifact,
        tradePathObserved: report.fills.length > 0,
      };
    }),
  );
  const payload = {
    formatVersion: 'strategy-study-result-v1' as const,
    manifestHash: contentHash(manifest),
    mode: 'paper' as const,
    executionEnabled: false as const,
    pointInTime: false as const,
    independentHoldoutVerified: false as const,
    strategySelected: false as const,
    inputs: datasets.map((exported, index) => ({
      id: manifest.datasets[index]!.id,
      role: manifest.datasets[index]!.role,
      artifactId: exported.id,
      contentHash: exported.contentHash,
      request: exported.dataset.request,
    })),
    runs,
  };
  const result = { resultHash: contentHash(payload), ...payload };
  reviewStrategyStudy(result, manifest);
  return result;
}

export function reviewStrategyStudy(input: unknown, manifestInput: unknown) {
  const manifest = parseStrategyStudyManifest(manifestInput);
  const parsed = resultSchema.safeParse(input);
  if (!parsed.success) throw new Error('STRATEGY_STUDY_RESULT_INVALID');
  const { resultHash, ...payload } = parsed.data;
  const fail = () => {
    throw new Error('STRATEGY_STUDY_RESULT_INVALID');
  };
  if (
    contentHash(payload) !== resultHash ||
    payload.manifestHash !== contentHash(manifest) ||
    payload.inputs.length !== manifest.datasets.length ||
    payload.runs.length !== manifest.datasets.length * manifest.variants.length
  )
    fail();
  const inputs = new Map(payload.inputs.map((entry) => [entry.id, entry]));
  if (inputs.size !== payload.inputs.length) fail();
  for (const entry of manifest.datasets) {
    const recorded = inputs.get(entry.id);
    if (
      !recorded ||
      recorded.role !== entry.role ||
      recorded.contentHash !== entry.contentHash ||
      contentHash(recorded.request) !== contentHash(entry.request)
    )
      fail();
  }
  const pairs = new Set<string>();
  for (const run of payload.runs) {
    const recorded = inputs.get(run.dataset);
    const variant = manifest.variants.find((entry) => entry.id === run.variant);
    const pair = `${run.dataset}/${run.variant}`;
    const { reportHash, ...artifact } = run.artifact;
    if (
      !recorded ||
      !variant ||
      pairs.has(pair) ||
      run.configHash !== contentHash({ strategy: variant.strategy, execution: variant.execution }) ||
      contentHash(artifact.report.strategy) !== contentHash(variant.strategy) ||
      contentHash(artifact.report.config) !== contentHash(variant.execution) ||
      contentHash(artifact.report.datasetRequest) !== contentHash(recorded.request) ||
      artifact.report.currency !== (recorded.request.instrument.market === 'KR' ? 'KRW' : 'USD') ||
      artifact.dataset.id !== recorded.artifactId ||
      artifact.dataset.contentHash !== recorded.contentHash ||
      artifact.dataset.source !== 'file' ||
      contentHash(artifact) !== reportHash ||
      run.tradePathObserved !== artifact.report.fills.length > 0
    )
      fail();
    pairs.add(pair);
  }
  return {
    formatVersion: 'strategy-study-review-v1',
    resultHash,
    manifestHash: payload.manifestHash,
    artifactIntegrityVerified: true,
    datasetFilesReverified: false,
    engineReexecuted: false,
    independentHoldoutVerified: false,
    strategySelected: false,
    executionEnabled: false,
    pointInTime: false,
    rows: payload.runs.map((run) => ({
      dataset: run.dataset,
      role: inputs.get(run.dataset)!.role,
      variant: run.variant,
      request: run.artifact.report.datasetRequest,
      currency: run.artifact.report.currency,
      strategy: run.artifact.report.strategy,
      execution: run.artifact.report.config,
      reportHash: run.artifact.reportHash,
      tradePathObserved: run.tradePathObserved,
      warmupSignals: run.artifact.report.signals.filter((signal) => signal.reason === 'WARMUP').length,
      unfilledAtEnd: run.artifact.report.signals.filter((signal) => signal.status === 'UNFILLED_END').length,
      metrics: run.artifact.report.metrics,
    })),
  };
}
