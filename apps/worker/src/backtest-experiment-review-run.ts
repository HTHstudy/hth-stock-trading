import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { paperModeSchema } from '@hth/contracts';
import { reviewBacktestExperiment } from './backtest-experiment-review.js';
import { readExperimentJson, writeExperimentResult } from './backtest-experiment-files.js';

async function main() {
  if (!paperModeSchema.safeParse(process.env.TRADING_MODE).success) throw new Error('BACKTEST_PAPER_ONLY');
  const { values } = parseArgs({
    options: { manifest: { type: 'string' }, input: { type: 'string' }, output: { type: 'string' } },
  });
  if (!values.manifest || !values.input || !values.output) throw new Error('EXPERIMENT_ARGUMENTS_REQUIRED');
  const manifest = await readExperimentJson(resolve(values.manifest), 1048576);
  const input = await readExperimentJson(resolve(values.input), 64 * 1048576);
  const review = reviewBacktestExperiment(input, manifest);
  await writeExperimentResult(values.output, review);
  console.info(
    JSON.stringify({
      service: 'backtest-experiment-review',
      resultHash: review.resultHash,
      rows: review.rows.length,
      artifactIntegrityVerified: true,
      engineReexecuted: false,
      executionEnabled: false,
    }),
  );
}
main().catch((error: unknown) => {
  const allowed = [
    'BACKTEST_PAPER_ONLY',
    'EXPERIMENT_ARGUMENTS_REQUIRED',
    'EXPERIMENT_RESULT_INVALID',
    'INVALID_EXPERIMENT_MANIFEST',
    'EXPERIMENT_FILE_TOO_LARGE',
    'INVALID_EXPERIMENT_JSON',
    'EXPERIMENT_OUTPUT_JSON_REQUIRED',
  ];
  const code =
    error instanceof Error && allowed.includes(error.message)
      ? error.message
      : error instanceof Error && 'code' in error && error.code === 'EEXIST'
        ? 'EXPERIMENT_RESULT_EXISTS'
        : 'EXPERIMENT_REVIEW_FAILED';
  console.error(JSON.stringify({ service: 'backtest-experiment-review', code, executionEnabled: false }));
  process.exitCode = 1;
});
