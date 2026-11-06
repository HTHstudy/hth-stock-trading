import { parseArgs } from 'node:util';
import { dirname, resolve } from 'node:path';
import { paperModeSchema } from '@hth/contracts';
import { parseStrategyStudyManifest, reviewStrategyStudy, runStrategyStudy } from './strategy-study.js';
import { readExperimentJson, writeExperimentResult } from './backtest-experiment-files.js';

async function main() {
  if (!paperModeSchema.safeParse(process.env.TRADING_MODE).success) throw new Error('BACKTEST_PAPER_ONLY');
  const { values } = parseArgs({
    options: {
      manifest: { type: 'string' },
      output: { type: 'string' },
      input: { type: 'string' },
    },
  });
  if (!values.manifest || !values.output || !/\.json$/i.test(values.output))
    throw new Error('EXPERIMENT_ARGUMENTS_REQUIRED');
  const manifestPath = resolve(values.manifest);
  const manifest = parseStrategyStudyManifest(await readExperimentJson(manifestPath, 1048576));
  if (values.input) {
    const review = reviewStrategyStudy(await readExperimentJson(resolve(values.input), 64 * 1048576), manifest);
    await writeExperimentResult(values.output, review);
    console.info(
      JSON.stringify({
        service: 'strategy-study',
        action: 'review',
        resultHash: review.resultHash,
        datasetFilesReverified: false,
        engineReexecuted: false,
        executionEnabled: false,
      }),
    );
    return;
  }
  const inputs: unknown[] = [];
  const budget = { remainingBytes: 64 * 1048576 };
  for (const entry of manifest.datasets)
    inputs.push(await readExperimentJson(resolve(dirname(manifestPath), entry.path), 64 * 1048576, budget));
  const result = runStrategyStudy(manifest, inputs);
  await writeExperimentResult(values.output, result);
  console.info(
    JSON.stringify({
      service: 'strategy-study',
      action: 'run',
      resultHash: result.resultHash,
      manifestHash: result.manifestHash,
      runs: result.runs.length,
      independentHoldoutVerified: false,
      strategySelected: false,
      executionEnabled: false,
    }),
  );
}

main().catch((error: unknown) => {
  const allowed = [
    'BACKTEST_PAPER_ONLY',
    'INVALID_STRATEGY_STUDY_MANIFEST',
    'STRATEGY_STUDY_RESULT_INVALID',
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
  ];
  const code =
    error instanceof Error && allowed.includes(error.message)
      ? error.message
      : error instanceof Error && 'code' in error && error.code === 'EEXIST'
        ? 'EXPERIMENT_RESULT_EXISTS'
        : 'STRATEGY_STUDY_FAILED';
  console.error(JSON.stringify({ service: 'strategy-study', code, executionEnabled: false }));
  process.exitCode = 1;
});
