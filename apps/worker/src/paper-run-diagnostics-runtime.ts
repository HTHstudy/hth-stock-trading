import { parseArgs } from 'node:util';
import { join, resolve } from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { z } from 'zod';
import { paperModeSchema, paperReviewCheckpointSchema } from '@hth/contracts';
import { createDatabase, contentHash } from '@hth/database';
import {
  dedicatedPaperDatabaseUrl,
  assertDedicatedPaperDatabase,
  localComposeEnvironment,
} from '@hth/database/testing';
import { readReviewEvidence, writeReviewArtifact } from './paper-review-files.js';
import { summarizeRunDiagnostics } from './paper-run-diagnostics.js';

export async function captureRunDiagnostics(
  args: string[],
  environment: Record<string, string | undefined>,
  root = process.cwd(),
  dependencies = { openDatabase: createDatabase, assertDatabase: assertDedicatedPaperDatabase },
) {
  paperModeSchema.parse(environment.TRADING_MODE);
  const { values } = parseArgs({
    args,
    options: { capture: { type: 'boolean', default: false }, run: { type: 'string' }, account: { type: 'string' } },
  });
  if (!values.capture) {
    if (values.run || values.account) throw new Error('INVALID_OPTIONS');
    return { service: 'paper-run-diagnostics', state: 'preview', executionEnabled: false, canResume: false };
  }
  const id = z.uuid().parse(values.run),
    account = z
      .string()
      .regex(/^paper-market-[A-Za-z0-9._:-]{1,70}$/)
      .parse(values.account);
  const base = resolve(root, '.local-data/paper-validation-runs'),
    folder = join(base, id);
  if (
    (await lstat(base)).isSymbolicLink() ||
    (await lstat(folder)).isSymbolicLink() ||
    (await realpath(folder)) !== join(await realpath(base), id)
  )
    throw new Error('INVALID_ROOT');
  const before = paperReviewCheckpointSchema.parse(await readReviewEvidence(join(folder, 'before.json')));
  const after = paperReviewCheckpointSchema.parse(await readReviewEvidence(join(folder, 'after.json')));
  if (contentHash(before.snapshot) !== before.hash || contentHash(after.snapshot) !== after.hash)
    throw new Error('INVALID_EVIDENCE');
  const env = { ...environment, ...localComposeEnvironment(environment) };
  const url = dedicatedPaperDatabaseUrl(env.PAPER_MARKET_DATABASE_URL);
  const database = dependencies.openDatabase(url);
  try {
    await dependencies.assertDatabase(database, url);
    const artifact = await database.paperReview.captureDiagnostics(account, before, after);
    const summary = summarizeRunDiagnostics(artifact, before, after);
    if (Buffer.byteLength(JSON.stringify(artifact, null, 2) + '\n') > 8 * 1048576) throw new Error('ARTIFACT_LIMIT');
    await writeReviewArtifact(join(folder, 'diagnostics.json'), artifact);
    return {
      service: 'paper-run-diagnostics',
      state: 'captured',
      recordedBatches: summary.recordedBatches,
      recordedReports: summary.recordedReports,
      executionEnabled: false,
      canResume: false,
    };
  } finally {
    await database.close();
  }
}
