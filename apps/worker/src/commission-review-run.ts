import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { paperModeSchema } from '@hth/contracts';
import { contentHash } from '@hth/database';
import { readExperimentJson, writeExperimentResult } from './backtest-experiment-files.js';
import { reviewCommissionAssumptions } from './commission-review.js';

async function main() {
  paperModeSchema.parse(process.env.TRADING_MODE);
  const { values, tokens } = parseArgs({
    options: {
      input: { type: 'string' },
      assumptions: { type: 'string' },
      output: { type: 'string' },
      'reviewed-at': { type: 'string' },
    },
    tokens: true,
    allowPositionals: false,
    strict: true,
  });
  const seen = new Set<string>();
  for (const token of tokens) {
    if (token.kind !== 'option' || seen.has(token.name)) throw new Error('INVALID_OPTIONS');
    seen.add(token.name);
  }
  if (tokens.length === 0) {
    console.info(JSON.stringify({ service: 'commission-review', state: 'preview', executionEnabled: false }));
    return;
  }
  if (!values.input || !values.assumptions || !values.output) throw new Error('INVALID_OPTIONS');
  const evidence = await readExperimentJson(resolve(values.input), 1048576);
  const assumptions = await readExperimentJson(resolve(values.assumptions), 1048576);
  const report = reviewCommissionAssumptions(evidence, assumptions, values['reviewed-at'] ?? new Date().toISOString());
  await writeExperimentResult(values.output, { report, hash: contentHash(report) });
  console.info(
    JSON.stringify({
      service: 'commission-review',
      state: 'reviewed',
      rows: report.rows.length,
      executionEnabled: false,
    }),
  );
}
main().catch(() => {
  console.error(
    JSON.stringify({ service: 'commission-review', code: 'COMMISSION_REVIEW_NOT_COMPLETED', executionEnabled: false }),
  );
  process.exitCode = 1;
});
