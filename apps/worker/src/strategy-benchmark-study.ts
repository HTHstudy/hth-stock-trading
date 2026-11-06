import { z } from 'zod';
import { Decimal } from 'decimal.js';
import {
  backtestArtifactSchema,
  buyAndHoldConfigSchema,
  capitalExposureSchema,
  createBacktestReportSchema,
  reportHashSchema,
} from '@hth/contracts';
import type { StrategyResearchSnapshot } from '@hth/contracts';
import { canonicalJson, contentHash } from '@hth/database';
import { buyAndHold, calculateCapitalExposure, runBacktest } from '@hth/trading';
import {
  reviewStrategyStudy,
  runStrategyStudy,
  strategyStudyManifestSchema,
  strategyStudyResultSchema,
} from './strategy-study.js';
import { prepareExperimentInputs } from './backtest-experiment.js';
import { parseStrategyResearchSnapshot } from './strategy-research-snapshot.js';

const Money = Decimal.clone({ precision: 1000 });
const benchmarkDefinitionSchema = z
  .object({
    id: z.literal('buy-and-hold'),
    version: z.literal('1.0.0'),
    parameters: buyAndHoldConfigSchema,
  })
  .strict();
const benchmarkArtifactSchema = z
  .object({
    formatVersion: z.literal('strategy-benchmark-artifact-v1'),
    reportHash: reportHashSchema,
    dataset: backtestArtifactSchema.shape.dataset,
    report: createBacktestReportSchema(benchmarkDefinitionSchema),
  })
  .strict();
export const strategyBenchmarkManifestSchema = z
  .object({
    formatVersion: z.literal('strategy-benchmark-study-v1'),
    study: strategyStudyManifestSchema,
    benchmark: buyAndHoldConfigSchema,
    exposureModel: z.literal('acquisition-cost-calendar-time-v1'),
  })
  .strict()
  .superRefine((value, context) => {
    const executions = new Set(value.study.variants.map((variant) => contentHash(variant.execution)));
    const conditions = new Set(
      value.study.variants.map(({ strategy, execution }) => contentHash({ strategy, execution })),
    );
    if (conditions.size !== value.study.variants.length)
      context.addIssue({ code: 'custom', message: 'Duplicate strategy conditions' });
    if (value.study.datasets.length * (value.study.variants.length + executions.size) > 32)
      context.addIssue({ code: 'custom', message: 'Too many strategy and benchmark runs' });
    const eligibleCounts = value.study.variants.map(({ strategy }) => {
      switch (strategy.id) {
        case 'moving-average-cross':
          return strategy.parameters.slowPeriod + 1;
        case 'channel-breakout':
          return strategy.parameters.entryPeriod + 1;
        case 'mean-reversion':
          return strategy.parameters.period + 1;
      }
    });
    if (eligibleCounts.some((count) => count !== value.benchmark.entryAfterClosedCandles))
      context.addIssue({ code: 'custom', message: 'Benchmark and candidates must share first eligible signal count' });
  });
export function parseStrategyBenchmarkManifest(input: unknown) {
  const result = strategyBenchmarkManifestSchema.safeParse(input);
  if (!result.success) throw new Error('INVALID_STRATEGY_BENCHMARK_MANIFEST');
  return result.data;
}
const resultSchema = z
  .object({
    formatVersion: z.literal('strategy-benchmark-result-v1'),
    resultHash: reportHashSchema,
    manifestHash: reportHashSchema,
    mode: z.literal('paper'),
    executionEnabled: z.literal(false),
    independentHoldoutVerified: z.literal(false),
    strategySelected: z.literal(false),
    pointInTime: z.literal(false),
    study: strategyStudyResultSchema,
    benchmarks: z
      .array(
        z
          .object({
            dataset: z.string(),
            executionHash: reportHashSchema,
            artifact: benchmarkArtifactSchema,
          })
          .strict(),
      )
      .min(1)
      .max(16),
    exposures: z
      .array(z.object({ reportHash: reportHashSchema, value: capitalExposureSchema }).strict())
      .min(1)
      .max(32),
  })
  .strict();

export function runStrategyBenchmarkStudy(input: unknown, exports: unknown[]) {
  const manifest = parseStrategyBenchmarkManifest(input);
  const executions = new Map(
    manifest.study.variants.map((variant) => [contentHash(variant.execution), variant.execution]),
  );
  const datasets = prepareExperimentInputs(manifest.study, exports);
  const runCount = manifest.study.variants.length + executions.size;
  if (datasets.reduce((sum, { dataset }) => sum + dataset.candles.length, 0) * runCount > 100_000)
    throw new Error('EXPERIMENT_WORK_LIMIT');
  const study = runStrategyStudy(manifest.study, exports);
  let bytes = study.runs.reduce((sum, run) => sum + Buffer.byteLength(canonicalJson(run.artifact)), 0);
  const benchmarks = datasets.flatMap((exported, index) =>
    [...executions].map(([executionHash, execution]) => {
      const report = runBacktest({
        dataset: exported.dataset,
        strategy: buyAndHold,
        strategyConfig: manifest.benchmark,
        config: execution,
      });
      const payload = {
        formatVersion: 'strategy-benchmark-artifact-v1' as const,
        dataset: { id: exported.id, contentHash: exported.contentHash, source: 'file' as const },
        report,
      };
      const artifact = benchmarkArtifactSchema.parse({ reportHash: contentHash(payload), ...payload });
      bytes += Buffer.byteLength(canonicalJson(artifact));
      if (bytes > 32 * 1048576) throw new Error('EXPERIMENT_WORK_LIMIT');
      return { dataset: manifest.study.datasets[index]!.id, executionHash, artifact };
    }),
  );
  const exposures = [...study.runs, ...benchmarks].map(({ artifact }) => ({
    reportHash: artifact.reportHash,
    value: capitalExposureSchema.parse(calculateCapitalExposure(artifact.report)),
  }));
  const payload = {
    formatVersion: 'strategy-benchmark-result-v1' as const,
    manifestHash: contentHash(manifest),
    mode: 'paper' as const,
    executionEnabled: false as const,
    independentHoldoutVerified: false as const,
    strategySelected: false as const,
    pointInTime: false as const,
    study,
    benchmarks,
    exposures,
  };
  const result = { resultHash: contentHash(payload), ...payload };
  reviewStrategyBenchmarkStudy(result, manifest);
  return result;
}

export function reviewStrategyBenchmarkStudy(input: unknown, manifestInput: unknown) {
  const manifest = parseStrategyBenchmarkManifest(manifestInput);
  const parsed = resultSchema.safeParse(input);
  if (!parsed.success) throw new Error('STRATEGY_BENCHMARK_RESULT_INVALID');
  const { resultHash, ...payload } = parsed.data;
  const fail = () => {
    throw new Error('STRATEGY_BENCHMARK_RESULT_INVALID');
  };
  if (contentHash(payload) !== resultHash || payload.manifestHash !== contentHash(manifest)) fail();
  const studyReview = reviewStrategyStudy(payload.study, manifest.study);
  const executions = new Map(
    manifest.study.variants.map((variant) => [contentHash(variant.execution), variant.execution]),
  );
  if (payload.benchmarks.length !== manifest.study.datasets.length * executions.size) fail();
  const pairs = new Set<string>();
  for (const run of payload.benchmarks) {
    const source = payload.study.inputs.find((entry) => entry.id === run.dataset);
    const execution = executions.get(run.executionHash);
    const { reportHash, ...artifact } = run.artifact;
    const pair = `${run.dataset}/${run.executionHash}`;
    if (
      !source ||
      !execution ||
      pairs.has(pair) ||
      contentHash(artifact) !== reportHash ||
      artifact.dataset.id !== source.artifactId ||
      artifact.dataset.contentHash !== source.contentHash ||
      artifact.dataset.source !== 'file' ||
      contentHash(artifact.report.datasetRequest) !== contentHash(source.request) ||
      artifact.report.currency !== (source.request.instrument.market === 'KR' ? 'KRW' : 'USD') ||
      contentHash(artifact.report.config) !== run.executionHash ||
      contentHash(artifact.report.strategy.parameters) !== contentHash(manifest.benchmark)
    )
      fail();
    pairs.add(pair);
  }
  const reports = [...payload.study.runs, ...payload.benchmarks].map(({ artifact }) => artifact);
  const exposureMap = new Map(payload.exposures.map((entry) => [entry.reportHash, entry.value]));
  if (exposureMap.size !== reports.length || payload.exposures.length !== reports.length) fail();
  for (const artifact of reports) {
    if (
      contentHash(exposureMap.get(artifact.reportHash) ?? null) !==
      contentHash(calculateCapitalExposure(artifact.report))
    )
      fail();
  }
  const rows: StrategyResearchSnapshot['rows'] = studyReview.rows.map((row) => {
    const baseline = payload.benchmarks.find(
      (entry) => entry.dataset === row.dataset && entry.executionHash === contentHash(row.execution),
    );
    if (!baseline) throw new Error('STRATEGY_BENCHMARK_RESULT_INVALID');
    const baselineHasFills = baseline.artifact.report.fills.length > 0;
    const comparisonStatus = !row.tradePathObserved
      ? ('strategy-no-fills' as const)
      : !baselineHasFills
        ? ('benchmark-no-fills' as const)
        : ('compared' as const);
    return {
      dataset: row.dataset,
      variant: row.variant,
      kind: 'strategy' as const,
      strategy: row.strategy,
      execution: row.execution,
      reportHash: row.reportHash,
      tradePathObserved: row.tradePathObserved,
      warmupSignals: row.warmupSignals,
      unfilledAtEnd: row.unfilledAtEnd,
      metrics: row.metrics,
      exposure: exposureMap.get(row.reportHash)!,
      comparisonStatus,
      benchmarkReportHash: baseline.artifact.reportHash,
      netPnlDifference:
        comparisonStatus === 'compared'
          ? new Money(row.metrics.netPnl).minus(baseline.artifact.report.metrics.netPnl).toFixed()
          : null,
    };
  });
  for (const run of payload.benchmarks) {
    const report = run.artifact.report;
    rows.push({
      dataset: run.dataset,
      variant: `hold-${run.executionHash.slice(0, 24)}`,
      kind: 'benchmark',
      strategy: report.strategy,
      execution: report.config,
      reportHash: run.artifact.reportHash,
      tradePathObserved: report.fills.length > 0,
      warmupSignals: report.signals.filter((signal) => signal.reason === 'WARMUP').length,
      unfilledAtEnd: report.signals.filter((signal) => signal.status === 'UNFILLED_END').length,
      metrics: report.metrics,
      exposure: exposureMap.get(run.artifact.reportHash)!,
      comparisonStatus: 'benchmark',
      benchmarkReportHash: null,
      netPnlDifference: null,
    });
  }
  return {
    formatVersion: 'strategy-benchmark-review-v1',
    resultHash,
    manifestHash: payload.manifestHash,
    legacyStudyResultHash: payload.study.resultHash,
    artifactIntegrityVerified: true as const,
    datasetFilesReverified: false as const,
    engineReexecuted: false as const,
    independentHoldoutVerified: false as const,
    strategySelected: false as const,
    executionEnabled: false as const,
    pointInTime: false as const,
    benchmark: manifest.benchmark,
    datasets: manifest.study.datasets.map(({ id, role, request }) => ({ id, role, request })),
    rows,
  };
}

export function createStrategyResearchSnapshot(input: unknown, manifestInput: unknown): StrategyResearchSnapshot {
  const review = reviewStrategyBenchmarkStudy(input, manifestInput);
  const { resultHash, ...fields } = review;
  const payload = {
    ...fields,
    formatVersion: 'strategy-research-snapshot-v1' as const,
    sourceResultHash: resultHash,
    mode: 'paper' as const,
  };
  return parseStrategyResearchSnapshot({ snapshotHash: contentHash(payload), ...payload });
}
