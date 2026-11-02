import { parseArgs } from 'node:util';
import { dirname, resolve } from 'node:path';
import { paperModeSchema } from '@hth/contracts';
import { parseExperimentManifest, runBacktestExperiment } from './backtest-experiment.js';
import { readExperimentJson, writeExperimentResult } from './backtest-experiment-files.js';

async function main() {
  if (!paperModeSchema.safeParse(process.env.TRADING_MODE).success) throw new Error('BACKTEST_PAPER_ONLY');
  const { values } = parseArgs({ options: { manifest: { type: 'string' }, output: { type: 'string' } } });
  if (!values.manifest || !values.output || !/\.json$/i.test(values.output))
    throw new Error('EXPERIMENT_ARGUMENTS_REQUIRED');
  const manifestPath = resolve(values.manifest);
  const manifest = parseExperimentManifest(await readExperimentJson(manifestPath, 1048576));
  const inputs: unknown[] = [];
  const budget = { remainingBytes: 64 * 1048576 };
  // Read sequentially to bound simultaneous buffers; no broker or database connection.
  for (const dataset of manifest.datasets)
    inputs.push(await readExperimentJson(resolve(dirname(manifestPath), dataset.path), 64 * 1048576, budget));
  const result = runBacktestExperiment(manifest, inputs);
  await writeExperimentResult(values.output, result);
  console.info(
    JSON.stringify({
      service: 'backtest-experiment',
      mode: 'paper',
      executionEnabled: false,
      saved: true,
      resultHash: result.resultHash,
      manifestHash: result.manifestHash,
      runs: result.runs.map((run) => ({
        dataset: run.dataset,
        variant: run.variant,
        role: run.role,
        reportHash: run.artifact.reportHash,
        tradePathObserved: run.tradePathObserved,
        metrics: run.artifact.report.metrics,
      })),
      pointInTime: false,
    }),
  );
}
main().catch((error: unknown) => {
  const allowed = [
    'BACKTEST_PAPER_ONLY',
    'EXPERIMENT_ARGUMENTS_REQUIRED',
    'INVALID_EXPERIMENT_MANIFEST',
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
  ];
  const code =
    error instanceof Error && allowed.includes(error.message)
      ? error.message
      : error instanceof Error && 'code' in error && error.code === 'EEXIST'
        ? 'EXPERIMENT_RESULT_EXISTS'
        : 'EXPERIMENT_FAILED';
  console.error(JSON.stringify({ service: 'backtest-experiment', code, executionEnabled: false }));
  process.exitCode = 1;
});
