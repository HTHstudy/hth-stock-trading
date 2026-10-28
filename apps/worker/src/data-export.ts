import { mkdir, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { canonicalJson, createDatabase } from '@hth/database';
import { paperModeSchema } from '@hth/contracts';

async function main() {
  const { values } = parseArgs({ options: { id: { type: 'string' }, output: { type: 'string' } } });
  const config = z
    .object({
      DATABASE_URL: z.url().refine((value) => ['postgres:', 'postgresql:'].includes(new URL(value).protocol)),
      TRADING_MODE: paperModeSchema,
    })
    .safeParse(process.env);
  if (!config.success) throw new Error('DATASET_CONFIGURATION_INVALID');
  const database = createDatabase(config.data.DATABASE_URL);
  try {
    if (!values.id && !values.output) {
      const datasets = await database.datasets.list();
      console.info(JSON.stringify({ service: 'historical-datasets', datasets }));
      return;
    }
    if (!values.id || !values.output) throw new Error('DATASET_EXPORT_ARGUMENTS_REQUIRED');
    const result = await database.datasets.get(values.id);
    const target = resolve(values.output);
    if (!/\.json$/i.test(target)) throw new Error('DATASET_EXPORT_JSON_REQUIRED');
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(
      target,
      canonicalJson({ id: result.id, contentHash: result.contentHash, dataset: result.dataset }),
      { flag: 'wx', mode: 0o600 },
    );
    console.info(
      JSON.stringify({
        service: 'historical-dataset-export',
        id: result.id,
        contentHash: result.contentHash,
        exported: true,
      }),
    );
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  const allowed = [
    'INVALID_DATASET_ID',
    'DATASET_NOT_FOUND',
    'DATASET_INTEGRITY_FAILED',
    'DATASET_EXPORT_ARGUMENTS_REQUIRED',
    'DATASET_EXPORT_JSON_REQUIRED',
    'DATASET_CONFIGURATION_INVALID',
  ];
  console.error(
    JSON.stringify({
      service: 'historical-dataset-export',
      code: error instanceof Error && allowed.includes(error.message) ? error.message : 'DATASET_EXPORT_FAILED',
    }),
  );
  process.exitCode = 1;
});
