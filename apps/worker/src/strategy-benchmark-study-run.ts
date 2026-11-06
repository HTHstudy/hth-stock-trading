import { parseArgs } from 'node:util';
import { dirname, resolve } from 'node:path';
import { paperModeSchema } from '@hth/contracts';
import {
  parseStrategyBenchmarkManifest,
  runStrategyBenchmarkStudy,
  reviewStrategyBenchmarkStudy,
  createStrategyResearchSnapshot,
} from './strategy-benchmark-study.js';
import { readExperimentJson, writeExperimentResult } from './backtest-experiment-files.js';

async function main() {
  if (!paperModeSchema.safeParse(process.env.TRADING_MODE).success) throw new Error('BACKTEST_PAPER_ONLY');
  const { values } = parseArgs({
    options: {
      manifest: { type: 'string' },
      output: { type: 'string' },
      input: { type: 'string' },
      snapshot: { type: 'boolean' },
    },
  });
  if (!values.manifest || !values.output || !/\.json$/i.test(values.output) || (values.snapshot && !values.input))
    throw new Error('EXPERIMENT_ARGUMENTS_REQUIRED');
  const manifestPath = resolve(values.manifest);
  const manifest = parseStrategyBenchmarkManifest(await readExperimentJson(manifestPath, 1048576));
  if (values.input) {
    const input = await readExperimentJson(resolve(values.input), 64 * 1048576);
    if (values.snapshot) {
      const snapshot = createStrategyResearchSnapshot(input, manifest);
      await writeExperimentResult(values.output, snapshot);
      console.info(
        JSON.stringify({
          service: 'strategy-benchmark-study',
          action: 'snapshot',
          snapshotHash: snapshot.snapshotHash,
          engineReexecuted: false,
          executionEnabled: false,
        }),
      );
    } else {
      const review = reviewStrategyBenchmarkStudy(input, manifest);
      await writeExperimentResult(values.output, review);
      console.info(
        JSON.stringify({
          service: 'strategy-benchmark-study',
          action: 'review',
          resultHash: review.resultHash,
          engineReexecuted: false,
          executionEnabled: false,
        }),
      );
    }
    return;
  }
  const inputs: unknown[] = [],
    budget = { remainingBytes: 64 * 1048576 };
  for (const entry of manifest.study.datasets)
    inputs.push(await readExperimentJson(resolve(dirname(manifestPath), entry.path), 64 * 1048576, budget));
  const result = runStrategyBenchmarkStudy(manifest, inputs);
  await writeExperimentResult(values.output, result);
  console.info(
    JSON.stringify({
      service: 'strategy-benchmark-study',
      action: 'run',
      resultHash: result.resultHash,
      manifestHash: result.manifestHash,
      strategyRuns: result.study.runs.length,
      benchmarkRuns: result.benchmarks.length,
      independentHoldoutVerified: false,
      strategySelected: false,
      executionEnabled: false,
    }),
  );
}
main().catch((error: unknown) => {
  const allowed = [
    'BACKTEST_PAPER_ONLY',
    'INVALID_STRATEGY_BENCHMARK_MANIFEST',
    'STRATEGY_BENCHMARK_RESULT_INVALID',
    'EXPERIMENT_ARGUMENTS_REQUIRED',
    'EXPERIMENT_FILE_TOO_LARGE',
    'INVALID_EXPERIMENT_JSON',
    'EXPERIMENT_OUTPUT_JSON_REQUIRED',
    'EXPERIMENT_WORK_LIMIT',
    'EXPERIMENT_INPUT_MISMATCH',
    'EXPERIMENT_INCOMPARABLE_INPUTS',
    'EXPERIMENT_OVERLAPPING_PERIODS',
    'DATASET_INTEGRITY_FAILED',
    'INVALID_BACKTEST_DATASET',
    'BACKTEST_DATASET_PROOF_MISMATCH',
    'UNSUPPORTED_KR_DAILY_SESSION',
    'INVALID_EXECUTION_RULE',
    'UNSUPPORTED_EXECUTION_RULE_SCOPE',
    'INVALID_STRATEGY_CONFIG',
    'INVALID_STRATEGY_DATA',
    'INVALID_CAPITAL_EXPOSURE',
    'EXPERIMENT_RESULT_INVALID',
    'STRATEGY_STUDY_RESULT_INVALID',
  ];
  const code =
    error instanceof Error && allowed.includes(error.message)
      ? error.message
      : error instanceof Error && 'code' in error && error.code === 'EEXIST'
        ? 'EXPERIMENT_RESULT_EXISTS'
        : 'STRATEGY_BENCHMARK_FAILED';
  console.error(JSON.stringify({ service: 'strategy-benchmark-study', code, executionEnabled: false }));
  process.exitCode = 1;
});
