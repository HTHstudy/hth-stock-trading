import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { paperModeSchema } from '@hth/contracts';
import { createRiskDemo } from './risk-demo-model.js';

async function main() {
  if (!paperModeSchema.safeParse(process.env.TRADING_MODE).success) throw new Error('RISK_DEMO_PAPER_ONLY');
  const { values } = parseArgs({ options: { output: { type: 'string' } } });
  const fixture: unknown = JSON.parse(
    await readFile(new URL('../../../examples/paper-risk-input.json', import.meta.url), 'utf8'),
  );
  const report = createRiskDemo(fixture);
  if (values.output) {
    const target = resolve(values.output);
    if (!/\.json$/i.test(target)) throw new Error('RISK_DEMO_OUTPUT_JSON_REQUIRED');
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
  }
  console.info(
    JSON.stringify({
      service: 'paper-risk-demo',
      mode: 'paper',
      executionEnabled: false,
      source: 'synthetic-only',
      saved: Boolean(values.output),
      scenarios: report.results.length,
      eligible: report.results.filter((result) => result.canReserve).length,
      blocked: report.results.filter((result) => !result.canReserve).length,
      currentAfterStop: report.currentAfterStop,
    }),
  );
}

main().catch((error: unknown) => {
  const allowed = ['RISK_DEMO_PAPER_ONLY', 'RISK_DEMO_OUTPUT_JSON_REQUIRED'];
  const code =
    error instanceof Error && allowed.includes(error.message)
      ? error.message
      : error instanceof Error && 'code' in error && error.code === 'EEXIST'
        ? 'RISK_DEMO_REPORT_EXISTS'
        : 'RISK_DEMO_FAILED';
  console.error(JSON.stringify({ service: 'paper-risk-demo', code, executionEnabled: false }));
  process.exitCode = 1;
});
