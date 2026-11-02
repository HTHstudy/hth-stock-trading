import { constants } from 'node:fs';
import { mkdir, open, link, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { canonicalJson } from '@hth/database';

export async function readExperimentJson(
  path: string,
  limit: number,
  budget?: { remainingBytes: number },
): Promise<unknown> {
  limit = Math.min(limit, budget?.remainingBytes ?? limit);
  if (limit <= 0) throw new Error('EXPERIMENT_FILE_TOO_LARGE');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > limit) throw new Error('EXPERIMENT_FILE_TOO_LARGE');
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const part of file.createReadStream({ autoClose: false, start: 0, end: limit })) {
      const chunk = part as Buffer;
      bytes += chunk.length;
      if (bytes > limit) throw new Error('EXPERIMENT_FILE_TOO_LARGE');
      chunks.push(chunk);
    }
    if (budget) budget.remainingBytes -= bytes;
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch {
      throw new Error('INVALID_EXPERIMENT_JSON');
    }
  } finally {
    await file.close();
  }
}

export async function writeExperimentResult(path: string, input: unknown) {
  const target = resolve(path);
  if (!/\.json$/i.test(target)) throw new Error('EXPERIMENT_OUTPUT_JSON_REQUIRED');
  const serialized = canonicalJson(input);
  if (Buffer.byteLength(serialized) > 64 * 1048576) throw new Error('EXPERIMENT_FILE_TOO_LARGE');
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
    await link(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}
