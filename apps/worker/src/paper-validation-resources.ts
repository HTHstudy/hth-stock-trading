import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { paperModeSchema, paperValidationFailureCodeSchema } from '@hth/contracts';
import type { Market } from '@hth/contracts';
import { contentHash } from '@hth/database';
import { readPaperMarketPlan, verifyPaperMarketPlan } from './paper-market-plan.js';
import { writeReviewArtifact } from './paper-review-files.js';
import { runPaperPreparation } from './paper-preparation.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const marketSchema = z.enum(['KR', 'US']);
const manifestSchema = z
  .object({ formatVersion: z.literal('paper-validation-resources-v1'), market: marketSchema, planHash: hash })
  .strict();
const artifactSchema = z.object({ manifest: manifestSchema, hash }).strict();
async function readJson(path: string, limit: number): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error('PAPER_VALIDATION_RESOURCE_INVALID');
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const part of file.createReadStream({ autoClose: false, start: 0, end: limit })) {
      const chunk = part as Buffer;
      bytes += chunk.length;
      if (bytes > limit) throw new Error('PAPER_VALIDATION_RESOURCE_INVALID');
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally {
    await file.close();
  }
}
// Separate immutable inputs from compiled modules. Never derive an asset root
// from the relocated module's import.meta.url at execution time.
export async function createPaperValidationResources(
  parent: string,
  market: Market,
  sourcePlanPath: string,
  planHash: string,
) {
  marketSchema.parse(market);
  hash.parse(planHash);
  if (!isAbsolute(sourcePlanPath)) throw new Error('PAPER_VALIDATION_RESOURCE_INVALID');
  const plan = verifyPaperMarketPlan(await readPaperMarketPlan(sourcePlanPath), planHash);
  if (plan.strategy.instrument.market !== market) throw new Error('PAPER_VALIDATION_RESOURCE_INVALID');
  const directory = join(resolve(parent), randomUUID());
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const manifest = manifestSchema.parse({ formatVersion: 'paper-validation-resources-v1', market, planHash });
  await writeReviewArtifact(join(directory, 'plan.json'), plan);
  await writeReviewArtifact(join(directory, 'manifest.json'), { manifest, hash: contentHash(manifest) });
  return { directory, resourcesHash: contentHash(manifest) };
}
export async function verifyPaperValidationResources(directory: string, resourcesHash: string, market: Market) {
  try {
    if (!isAbsolute(directory)) throw new Error('PAPER_VALIDATION_RESOURCE_INVALID');
    hash.parse(resourcesHash);
    marketSchema.parse(market);
    const root = resolve(directory),
      stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('PAPER_VALIDATION_RESOURCE_INVALID');
    const canonical = await realpath(root);
    const artifact = artifactSchema.parse(await readJson(join(root, 'manifest.json'), 16384));
    if (
      contentHash(artifact.manifest) !== artifact.hash ||
      artifact.hash !== resourcesHash ||
      artifact.manifest.market !== market
    )
      throw new Error('PAPER_VALIDATION_RESOURCE_INVALID');
    const plan = verifyPaperMarketPlan(await readJson(join(root, 'plan.json'), 65536), artifact.manifest.planHash);
    if (plan.strategy.instrument.market !== market || (await realpath(root)) !== canonical)
      throw new Error('PAPER_VALIDATION_RESOURCE_INVALID');
    return { planPath: join(root, 'plan.json'), planHash: artifact.manifest.planHash, resourcesHash: artifact.hash };
  } catch (error) {
    if (error instanceof Error && error.message === 'PAPER_MARKET_PLAN_HASH_MISMATCH') throw error;
    throw new Error('PAPER_VALIDATION_RESOURCE_INVALID');
  }
}
export async function checkPaperValidationPreparation(
  input: { directory: string; resourcesHash: string; market: Market; accountId: string },
  environment: Record<string, string | undefined>,
  dependencies = { check: runPaperPreparation },
) {
  paperModeSchema.parse(environment.TRADING_MODE);
  z.string()
    .regex(/^paper-market-[A-Za-z0-9._:-]{1,70}$/)
    .parse(input.accountId);
  const resource = await verifyPaperValidationResources(input.directory, input.resourcesHash, input.market);
  return dependencies.check(
    ['--check', `--plan=${resource.planPath}`, `--plan-hash=${resource.planHash}`, `--account=${input.accountId}`],
    environment,
  );
}
export function paperValidationFailureCode(error: unknown, aborted = false) {
  if (aborted) return 'CANCELLED' as const;
  const code = paperValidationFailureCodeSchema.safeParse(error instanceof Error ? error.message : null);
  return code.success ? code.data : 'PAPER_VALIDATION_NOT_COMPLETED';
}
