import { parseArgs } from 'node:util';
import { z } from 'zod';
import { paperModeSchema, paperReviewArtifactSchema } from '@hth/contracts';
import { createDatabase, contentHash } from '@hth/database';
import {
  dedicatedPaperDatabaseUrl,
  assertDedicatedPaperDatabase,
  localComposeEnvironment,
} from '@hth/database/testing';
import { paperReviewCheckpoint, reviewPaperCheckpoints } from './paper-review.js';
import { readReviewEvidence, writeReviewArtifact } from './paper-review-files.js';

export function parsePaperReview(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      capture: { type: 'boolean', default: false },
      compare: { type: 'boolean', default: false },
      kind: { type: 'string' },
      account: { type: 'string' },
      before: { type: 'string' },
      after: { type: 'string' },
      output: { type: 'string' },
    },
  });
  if (values.capture && values.compare) throw new Error('PAPER_REVIEW_FLAGS_INVALID');
  if (!values.capture && !values.compare) {
    if (Object.values(values).some((value) => value !== false && value !== undefined))
      throw new Error('PAPER_REVIEW_FLAGS_INVALID');
    return { action: 'preview' as const };
  }
  const output = z.string().min(1).parse(values.output);
  if (values.capture) {
    if (values.before !== undefined || values.after !== undefined) throw new Error('PAPER_REVIEW_FLAGS_INVALID');
    const kind = z.enum(['market', 'synthetic']).parse(values.kind ?? 'market');
    const account = z
      .string()
      .regex(kind === 'market' ? /^paper-market-[A-Za-z0-9._:-]{1,70}$/ : /^paper-demo-[A-Za-z0-9._:-]{1,80}$/)
      .parse(values.account);
    return { action: 'capture' as const, kind, account, output };
  }
  if (values.account !== undefined || values.kind !== undefined) throw new Error('PAPER_REVIEW_FLAGS_INVALID');
  return { action: 'compare' as const, before: values.before, after: values.after, output };
}
export async function runPaperReview(
  args: string[],
  environment: Record<string, string | undefined>,
  dependencies = { openDatabase: createDatabase, assertDatabase: assertDedicatedPaperDatabase },
) {
  paperModeSchema.parse(environment.TRADING_MODE);
  const config = parsePaperReview(args);
  if (config.action === 'preview')
    return { service: 'paper-review', state: 'preview', executionEnabled: false, canResume: false };
  if (config.action === 'compare') {
    const [before, after] = await Promise.all([readReviewEvidence(config.before), readReviewEvidence(config.after)]);
    const report = reviewPaperCheckpoints(before, after, new Date().toISOString());
    const hash = contentHash(report);
    const artifact = paperReviewArtifactSchema.parse({ formatVersion: 'paper-review-artifact-v1', report, hash });
    await writeReviewArtifact(config.output, artifact);
    return {
      service: 'paper-review',
      state: 'report-written',
      hash,
      verdict: report.verdict,
      executionEnabled: false,
      canResume: false,
    };
  }
  const env = { ...environment, ...localComposeEnvironment(environment) };
  const local = environment.LOCAL_CONTAINER_MODE === 'true' && environment.NODE_ENV === 'production';
  const url = dedicatedPaperDatabaseUrl(
    config.kind === 'market' ? env.PAPER_MARKET_DATABASE_URL : env.PAPER_DEMO_DATABASE_URL,
    local,
  );
  const db = dependencies.openDatabase(url);
  try {
    await dependencies.assertDatabase(db, url, local);
    const checkpoint = paperReviewCheckpoint(
      await db.paperReview.capture(config.account, config.kind === 'market' ? 'toss-readonly' : 'synthetic-only'),
    );
    await writeReviewArtifact(config.output, checkpoint);
    return {
      service: 'paper-review',
      state: 'checkpoint-written',
      hash: checkpoint.hash,
      executionEnabled: false,
      canResume: false,
    };
  } finally {
    await db.close();
  }
}
