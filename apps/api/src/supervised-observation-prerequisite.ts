import { constants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { observationJobSchema } from '@hth/contracts';
import { verifyRegularSupervisionLink } from '@hth/worker/readonly-supervision-status';
import { verifyTokenLifecycleEvidence } from '@hth/worker/token-lifecycle-evidence';
import { createObservationReports } from './observation-reports.js';

function unchanged(before: BigIntStats, after: BigIntStats) {
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.mode !== after.mode ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs
  )
    throw new Error('SUPERVISED_PREREQUISITE_INVALID');
}

async function directory(path: string) {
  const info = await lstat(path, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(path)) !== path)
    throw new Error('SUPERVISED_PREREQUISITE_INVALID');
  return { path, info };
}

async function read(path: string, limit: number) {
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(limit))
    throw new Error('SUPERVISED_PREREQUISITE_INVALID');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    unchanged(before, await file.stat({ bigint: true }));
    const buffer = Buffer.alloc(limit + 1);
    let total = 0;
    while (total <= limit) {
      const { bytesRead } = await file.read(buffer, total, buffer.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > limit || BigInt(total) !== before.size) throw new Error('SUPERVISED_PREREQUISITE_INVALID');
    unchanged(before, await file.stat({ bigint: true }));
    unchanged(before, await lstat(path, { bigint: true }));
    const bytes = buffer.subarray(0, total);
    const data: unknown = JSON.parse(bytes.toString('utf8'));
    return { path, info: before, bytes, data, limit };
  } finally {
    await file.close();
  }
}

/** Server composition only: fixed private files, no execution or resume authority. */
export function createSupervisedObservationPrerequisite(projectRoot: string, now: () => number = Date.now) {
  const root = resolve(projectRoot);
  return {
    async get(supervisionId: string, jobId: string) {
      try {
        z.uuid().parse(supervisionId);
        observationJobSchema.shape.id.parse(jobId);
        const time = now();
        if (!Number.isFinite(time)) throw new Error('SUPERVISED_PREREQUISITE_INVALID');
        const local = join(root, '.local-data');
        const supervisions = join(local, 'readonly-supervisions');
        const supervision = join(supervisions, supervisionId);
        const directories = [];
        for (const path of [root, local, supervisions, supervision]) directories.push(await directory(path));
        const request = await read(join(supervision, 'request.json'), 64 * 1024);
        const result = await read(join(supervision, 'result.json'), 64 * 1024);
        const link = verifyRegularSupervisionLink(
          supervisionId,
          { request: request.data, result: result.data },
          time,
          jobId,
        );
        z.uuid().parse(link.reportId);
        const observations = join(supervision, 'observation');
        const observation = join(observations, link.reportId);
        for (const path of [observations, observation]) directories.push(await directory(path));
        // The reused reader verifies contents; retain identity across its entire read as well.
        const reportFiles = [];
        for (const name of ['manifest.json', 'summary.json', 'samples.jsonl']) {
          const path = join(observation, name);
          const info = await lstat(path, { bigint: true });
          if (!info.isFile() || info.isSymbolicLink()) throw new Error('SUPERVISED_PREREQUISITE_INVALID');
          reportFiles.push({ path, info });
        }
        const evidence = await createObservationReports(observations, undefined, () => time).getWithSampleRange(
          link.reportId,
        );
        const { report, sampleRange } = evidence;
        const { manifest, summary } = report;
        const start = sampleRange.startedAt === null ? NaN : Date.parse(sampleRange.startedAt);
        const end = sampleRange.finishedAt === null ? NaN : Date.parse(sampleRange.finishedAt);
        const finished = report.finishedAt === null ? NaN : Date.parse(report.finishedAt);
        if (
          manifest.id !== link.reportId ||
          link.job.reportId !== link.reportId ||
          manifest.source !== 'toss-readonly' ||
          manifest.samples !== 60 ||
          manifest.intervalMs !== link.job.intervalSeconds * 1000 ||
          manifest.timeoutMs !== 10_000 ||
          manifest.instruments.length !== 1 ||
          manifest.instruments[0]?.market !== link.job.instrument.market ||
          manifest.instruments[0]?.symbol !== link.job.instrument.symbol ||
          report.state !== 'completed' ||
          report.recordedSamples !== 60 ||
          report.journalSha256 !== link.journalSha256 ||
          report.monitoring?.evidence !== 'final-hash-verified' ||
          report.monitoring.state !== 'terminal' ||
          report.monitoring.gapCount !== 0 ||
          report.monitoring.partialWrite ||
          report.monitoring.lastRecordedAt !== sampleRange.finishedAt ||
          report.monitoring.lastSuccessfulAt !== sampleRange.finishedAt ||
          !summary ||
          summary.samples !== 60 ||
          summary.successfulSamples !== 60 ||
          summary.healthy !== 60 ||
          summary.errorSamples !== 0 ||
          summary.closed !== 0 ||
          summary.blocked !== 0 ||
          summary.quoteRegressions !== 0 ||
          !Number.isFinite(start) ||
          !Number.isFinite(end) ||
          !Number.isFinite(finished) ||
          start < Date.parse(link.sessionStartsAt) ||
          start < Date.parse(link.job.startsAt) ||
          end < start ||
          end >= Date.parse(link.sessionEndsAt) ||
          Date.parse(manifest.startedAt) < Date.parse(link.job.startsAt) ||
          Date.parse(manifest.startedAt) < Date.parse(link.job.launchedAt) ||
          finished < Date.parse(manifest.startedAt) ||
          finished >= Date.parse(link.sessionEndsAt) ||
          start < Date.parse(manifest.startedAt) ||
          finished < end ||
          finished > time ||
          finished > Date.parse(link.supervisorFinishedAt)
        )
          throw new Error('SUPERVISED_PREREQUISITE_INVALID');
        const token = await read(join(observation, 'token-lifecycle.json'), 128 * 1024);
        const { snapshot } = verifyTokenLifecycleEvidence(token.data, manifest);
        if (
          snapshot.clockUnverified ||
          snapshot.limited ||
          snapshot.inFlight !== 0 ||
          snapshot.capturedAt === null ||
          Date.parse(snapshot.capturedAt) > Date.parse(link.supervisorFinishedAt)
        )
          throw new Error('SUPERVISED_PREREQUISITE_INVALID');
        for (const original of [request, result, token]) {
          const latest = await read(original.path, original.limit);
          unchanged(original.info, latest.info);
          if (!original.bytes.equals(latest.bytes)) throw new Error('SUPERVISED_PREREQUISITE_INVALID');
        }
        for (const original of reportFiles) unchanged(original.info, await lstat(original.path, { bigint: true }));
        for (const original of directories) unchanged(original.info, (await directory(original.path)).info);
        return {
          job: link.job,
          evidence,
          supervisionHash: link.supervisionHash,
          sessionStartsAt: link.sessionStartsAt,
          sessionEndsAt: link.sessionEndsAt,
        };
      } catch {
        throw new Error('SUPERVISED_PREREQUISITE_INVALID');
      }
    },
  };
}
