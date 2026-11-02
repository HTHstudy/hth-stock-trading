import { constants } from 'node:fs';
import { mkdir, open, link, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';

export async function readReviewEvidence(path: string | undefined): Promise<unknown> {
  if (!path) return null;
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      const limit = 32 * 1048576;
      if (!info.isFile() || info.size > limit) return { invalid: true };
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const part of file.createReadStream({ autoClose: false, start: 0, end: limit })) {
        const chunk = part as Buffer;
        bytes += chunk.length;
        if (bytes > limit) return { invalid: true };
        chunks.push(chunk);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } finally {
      await file.close();
    }
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT' ? null : { invalid: true };
  }
}
export async function writeReviewArtifact(path: string, value: unknown) {
  const serialized = JSON.stringify(value, null, 2) + '\n';
  if (Buffer.byteLength(serialized) > 32 * 1048576) throw new Error('PAPER_REVIEW_FILE_TOO_LARGE');
  const target = resolve(path);
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
