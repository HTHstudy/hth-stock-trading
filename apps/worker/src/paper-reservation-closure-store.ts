import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { contentHash } from '@hth/database';
import { writeReviewArtifact } from './paper-review-files.js';
import { ownedPaperLaunchSchema, paperReservationClosureSchema } from './paper-reservation-closure-contracts.js';
import { planPaperReservationClosure, verifyPaperReservationClosure } from './paper-reservation-closure.js';

async function directory(path: string) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(path)) !== resolve(path))
    throw new Error('PAPER_CLOSURE_EVIDENCE_INVALID');
}
async function json(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > 16384) throw new Error('PAPER_CLOSURE_EVIDENCE_INVALID');
    const buffer = Buffer.alloc(16385);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const part = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (!part.bytesRead) break;
      bytesRead += part.bytesRead;
    }
    const after = await handle.stat();
    if (bytesRead !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs)
      throw new Error('PAPER_CLOSURE_EVIDENCE_INVALID');
    const bytes = buffer.subarray(0, bytesRead);
    return {
      value: JSON.parse(bytes.toString('utf8')) as unknown,
      bytes: bytesRead,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  } finally {
    await handle.close();
  }
}
export function createPaperReservationClosures(root: string, now: () => number = Date.now) {
  const workspace = resolve(root),
    runs = join(workspace, '.local-data/paper-validation-runs'),
    witnesses = join(workspace, '.local-data/paper-validation-processes'),
    closures = join(workspace, '.local-data/paper-reservation-closures');
  async function original(runId: string) {
    z.uuid().parse(runId);
    await directory(workspace);
    await directory(join(workspace, '.local-data'));
    await directory(runs);
    const path = join(runs, runId);
    await directory(path);
    const names = (await readdir(path)).sort();
    if (contentHash(names) !== contentHash(['result.json'])) throw new Error('PAPER_CLOSURE_SNAPSHOT_CHANGED');
    const terminal = await json(join(path, 'result.json'));
    await directory(path);
    if (contentHash((await readdir(path)).sort()) !== contentHash(names))
      throw new Error('PAPER_CLOSURE_SNAPSHOT_CHANGED');
    return {
      snapshot: {
        runId,
        files: [{ name: 'result.json' as const, bytes: terminal.bytes, sha256: terminal.sha256 }],
        missing: ['request.json', 'before.json', 'after.json', 'review.json'] as const,
      },
      terminal: terminal.value,
    };
  }
  async function evidence(runId: string, launchId: string) {
    z.uuid().parse(launchId);
    const base = await original(runId);
    await directory(witnesses);
    const path = join(witnesses, launchId);
    await directory(path);
    const launch = (await json(join(path, 'launch.json'))).value,
      exit = (await json(join(path, 'exit.json'))).value;
    await directory(path);
    const after = await original(runId);
    if (contentHash(after) !== contentHash(base)) throw new Error('PAPER_CLOSURE_SNAPSHOT_CHANGED');
    return { ...after, launch, exit };
  }
  async function verifyRecord(runId: string) {
    z.uuid().parse(runId);
    await directory(closures);
    const receipt = paperReservationClosureSchema.parse((await json(join(closures, runId + '.json'))).value);
    if (receipt.runId !== runId) throw new Error('PAPER_CLOSURE_EVIDENCE_INVALID');
    const value = await evidence(runId, receipt.launchId);
    ownedPaperLaunchSchema.parse(value.launch);
    return { ...verifyPaperReservationClosure(receipt, value, now()), receiptHash: receipt.hash };
  }
  return {
    async inspect(runId: string, launchId: string) {
      const value = await evidence(runId, launchId);
      return planPaperReservationClosure(value, now());
    },
    async apply(runId: string, launchId: string, expectedPlanHash: string, confirmation: string) {
      if (confirmation !== 'RETIRE_ORPHANED_RESERVATION') throw new Error('PAPER_CLOSURE_CONFIRMATION_REQUIRED');
      const before = await evidence(runId, launchId),
        plan = planPaperReservationClosure(before, now());
      if (plan.hash !== expectedPlanHash) throw new Error('PAPER_CLOSURE_PLAN_CHANGED');
      const body = {
        formatVersion: 'paper-reservation-closure-v1' as const,
        runId,
        launchId,
        snapshotHash: plan.snapshotHash,
        launchHash: plan.launchHash,
        exitHash: plan.exitHash,
        terminalHash: plan.terminalHash,
        scope: plan.scope,
        historicalOutcomeVerified: false as const,
        createdAt: new Date(now()).toISOString(),
        executionEnabled: false as const,
        canResume: false as const,
      };
      const receipt = paperReservationClosureSchema.parse({ ...body, hash: contentHash(body) });
      verifyPaperReservationClosure(receipt, before, now());
      if (contentHash(await evidence(runId, launchId)) !== contentHash(before))
        throw new Error('PAPER_CLOSURE_SNAPSHOT_CHANGED');
      // Writer creates only this separate receipt; original records are never edited.
      await mkdir(closures, { recursive: true, mode: 0o700 });
      await directory(closures);
      await writeReviewArtifact(join(closures, runId + '.json'), receipt);
      const after = await evidence(runId, launchId);
      verifyPaperReservationClosure(receipt, after, now());
      return { runId, receiptHash: receipt.hash, reservationRetired: true, executionEnabled: false, canResume: false };
    },
    verify: verifyRecord,
    async audit() {
      const verified: Array<{ runId: string; receiptHash: string }> = [],
        invalidIds: string[] = [];
      let unknownCount = 0,
        limited = false;
      const output = (availability: 'available' | 'not-recorded' | 'unavailable') => ({
        availability,
        verified: verified.sort((a, b) => a.runId.localeCompare(b.runId)),
        invalidIds: invalidIds.sort(),
        unknownCount,
        limited,
      });
      try {
        await directory(workspace);
        await directory(join(workspace, '.local-data'));
        await directory(closures);
      } catch (error) {
        return output(
          error instanceof Error && 'code' in error && error.code === 'ENOENT' ? 'not-recorded' : 'unavailable',
        );
      }
      try {
        let scanned = 0;
        for await (const entry of await opendir(closures)) {
          if (++scanned > 100) {
            limited = true;
            break;
          }
          const id = entry.name.endsWith('.json') ? entry.name.slice(0, -5) : '';
          if (!z.uuid().safeParse(id).success) {
            unknownCount++;
            continue;
          }
          try {
            const result = await verifyRecord(id);
            verified.push({ runId: id, receiptHash: result.receiptHash });
          } catch {
            invalidIds.push(id);
          }
        }
        await directory(closures);
        return output('available');
      } catch {
        return output('unavailable');
      }
    },
  };
}
