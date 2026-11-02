import { randomUUID } from 'node:crypto';
import { mkdir, open, link, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { historicalDatasetSchema } from '@hth/contracts';
import { canonicalJson, contentHash } from '@hth/database';
import { parseDatasetExport } from './backtest-artifact.js';

export function validateHistoricalOutput(path: string) {
  if (!path.trim() || !/\.json$/i.test(path) || path.includes('\0')) throw new Error('DATASET_EXPORT_JSON_REQUIRED');
  return resolve(path);
}

export async function exportHistoricalDataset(path: string, input: unknown, signal: AbortSignal) {
  const target = validateHistoricalOutput(path);
  signal.throwIfAborted();
  const dataset = historicalDatasetSchema.parse(input);
  if (!dataset.coverage.complete || dataset.candles.length === 0 || dataset.candles.some((bar) => !bar.isClosed))
    throw new Error('INCOMPLETE_DATASET');
  const artifact = parseDatasetExport({ id: randomUUID(), contentHash: contentHash(dataset), dataset });
  const serialized = canonicalJson(artifact);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = target + '.tmp-' + randomUUID();
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(serialized);
      await file.sync();
    } finally {
      await file.close();
    }
    signal.throwIfAborted();
    // Publishing a complete file is atomic and never replaces an existing target.
    await link(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
  return { id: artifact.id, contentHash: artifact.contentHash };
}
