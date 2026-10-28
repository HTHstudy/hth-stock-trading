import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { paperModeSchema } from '@hth/contracts';
import { canonicalJson, createDatabase } from '@hth/database';
import { createBacktestDemo } from './backtest-demo.js';
import { createBacktestArtifact, parseDatasetExport } from './backtest-artifact.js';

async function readJson(path: string, maxBytes: number): Promise<unknown> {
  const info = await stat(path);
  if (!info.isFile() || info.size > maxBytes) throw new Error('BACKTEST_FILE_TOO_LARGE');
  const buffer = await readFile(path);
  if (buffer.length > maxBytes) throw new Error('BACKTEST_FILE_TOO_LARGE');
  try {
    return JSON.parse(buffer.toString('utf8')) as unknown;
  } catch {
    throw new Error('INVALID_BACKTEST_JSON');
  }
}

async function main() {
  if (!paperModeSchema.safeParse(process.env.TRADING_MODE).success) throw new Error('BACKTEST_PAPER_ONLY');
  const { values } = parseArgs({
    options: {
      demo: { type: 'boolean', default: false },
      input: { type: 'string' },
      dataset: { type: 'string' },
      config: { type: 'string' },
      output: { type: 'string' },
    },
  });
  if ([values.demo, Boolean(values.input), Boolean(values.dataset)].filter(Boolean).length !== 1 || !values.config)
    throw new Error('BACKTEST_ARGUMENTS_REQUIRED');
  const config = await readJson(resolve(values.config), 1_048_576);
  const source = values.demo ? 'synthetic-demo' : values.input ? 'file' : 'database';
  const loaded = await (async () => {
    if (values.demo) return { id: null, dataset: createBacktestDemo() };
    if (values.input) return parseDatasetExport(await readJson(resolve(values.input), 64 * 1_048_576));
    const url = z
      .url()
      .refine((value) => ['postgres:', 'postgresql:'].includes(new URL(value).protocol))
      .safeParse(process.env.DATABASE_URL);
    if (!url.success) throw new Error('BACKTEST_DATABASE_CONFIGURATION_INVALID');
    const database = createDatabase(url.data);
    try {
      return await database.datasets.get(values.dataset!);
    } finally {
      await database.close();
    }
  })();
  const artifact = createBacktestArtifact({ dataset: loaded.dataset, datasetId: loaded.id, source, config });
  if (values.output) {
    const target = resolve(values.output);
    if (!/\.json$/i.test(target)) throw new Error('BACKTEST_OUTPUT_JSON_REQUIRED');
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, canonicalJson(artifact), { flag: 'wx', mode: 0o600 });
  }
  console.info(
    JSON.stringify({
      service: 'backtest',
      mode: 'paper',
      executionEnabled: false,
      source,
      reportHash: artifact.reportHash,
      datasetHash: artifact.dataset.contentHash,
      saved: Boolean(values.output),
      currency: artifact.report.currency,
      metrics: artifact.report.metrics,
      pointInTime: false,
    }),
  );
}

main().catch((error: unknown) => {
  const allowed = [
    'BACKTEST_PAPER_ONLY',
    'BACKTEST_ARGUMENTS_REQUIRED',
    'BACKTEST_FILE_TOO_LARGE',
    'INVALID_BACKTEST_JSON',
    'BACKTEST_DATABASE_CONFIGURATION_INVALID',
    'BACKTEST_OUTPUT_JSON_REQUIRED',
    'DATASET_INTEGRITY_FAILED',
    'DATASET_NOT_FOUND',
    'INVALID_DATASET_ID',
    'INVALID_BACKTEST_CONFIG',
    'INVALID_BACKTEST_DATASET',
    'INVALID_BACKTEST_PRICE',
    'UNSUPPORTED_KR_DAILY_SESSION',
    'BACKTEST_DATASET_PROOF_MISMATCH',
    'INVALID_STRATEGY_CONFIG',
    'INVALID_STRATEGY_DATA',
    'INVALID_STRATEGY_SIGNAL',
  ];
  const code =
    error instanceof Error && allowed.includes(error.message)
      ? error.message
      : error instanceof Error && 'code' in error && error.code === 'EEXIST'
        ? 'BACKTEST_REPORT_EXISTS'
        : 'BACKTEST_FAILED';
  console.error(JSON.stringify({ service: 'backtest', code, executionEnabled: false }));
  process.exitCode = 1;
});
