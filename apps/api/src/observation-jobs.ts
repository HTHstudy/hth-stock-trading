import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import {
  observationFailureSchema,
  observationJobSchema,
  observationJobsSchema,
  watchlistInstrumentSchema,
} from '@hth/contracts';
import type { ObservationJobs } from '@hth/contracts';

const launchSchema = z
  .object({
    name: observationJobSchema.shape.id,
    pid: z.number().int().positive(),
    launchedAt: z.iso.datetime({ offset: true }),
    startAt: z.iso.datetime({ offset: true }),
    symbols: z.string().max(50),
    samples: z.number().int().min(1).max(10000),
    intervalSeconds: z.number().int().min(10).max(3600),
    stateAtLaunch: z.literal('waiting'),
    executionEnabled: z.literal(false),
    scriptSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const context = { service: z.literal('market-observation'), executionEnabled: z.literal(false) };
const waitingSchema = z
  .object({ ...context, state: z.literal('waiting'), startsAt: z.iso.datetime({ offset: true }) })
  .strict();
const terminalSchema = z.union([
  z.object({ ...context, code: observationFailureSchema.shape.failure.shape.code }).strict(),
  z.object({ ...context, state: z.literal('cancelled') }).strict(),
  z
    .object({
      ...context,
      runId: z.uuid(),
      source: z.literal('toss-readonly'),
      state: z.enum(['completed', 'failed', 'cancelled']),
      samples: z.number().int().min(0).max(10000),
      errorSamples: z.number().int().min(0).max(10000),
    })
    .strict(),
]);
const missing = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT';

export function createObservationJobs(directory: string, now: () => number = Date.now) {
  const root = resolve(directory);
  return {
    async list(): Promise<ObservationJobs> {
      const asOf = new Date(now()).toISOString();
      const jobs: ObservationJobs['jobs'] = [];
      let rejectedCount = 0,
        candidates = 0,
        bytes = 0,
        limited = false;
      async function read(path: string, limit: number) {
        const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const info = await file.stat();
          if (!info.isFile() || info.size > limit) throw new Error('INVALID_JOB');
          if (bytes + info.size > 512 * 1024) {
            limited = true;
            throw new Error('SCAN_LIMIT');
          }
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of file.createReadStream({ autoClose: false, start: 0, end: limit })) {
            const part = chunk as Buffer;
            size += part.length;
            bytes += part.length;
            if (size > limit || bytes > 512 * 1024) {
              if (bytes > 512 * 1024) limited = true;
              throw new Error('INVALID_JOB');
            }
            chunks.push(part);
          }
          return Buffer.concat(chunks).toString('utf8');
        } finally {
          await file.close();
        }
      }
      try {
        const info = await lstat(root);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('INVALID_ROOT');
        const canonical = await realpath(root);
        for await (const entry of await opendir(root)) {
          if (++candidates > 100 || jobs.length >= 20 || limited) {
            limited = true;
            break;
          }
          if (!observationJobSchema.shape.id.safeParse(entry.name).success) continue;
          try {
            const folder = join(root, entry.name);
            if (
              !entry.isDirectory() ||
              entry.isSymbolicLink() ||
              (await realpath(folder)) !== join(canonical, entry.name)
            )
              throw new Error('INVALID_JOB');
            const launch = launchSchema.parse(JSON.parse(await read(join(folder, 'launch.json'), 4096)));
            if (
              launch.name !== entry.name ||
              Date.parse(launch.startAt) - Date.parse(launch.launchedAt) > 36 * 3600000 ||
              Date.parse(launch.startAt) < Date.parse(launch.launchedAt) - 120000
            )
              throw new Error('INVALID_JOB');
            const match = /^(KR|US):([A-Za-z0-9.-]{1,40})$/.exec(launch.symbols);
            if (!match) throw new Error('INVALID_JOB');
            const instrument = watchlistInstrumentSchema.parse({ market: match[1], symbol: match[2] });
            const lines = (await read(join(folder, 'process.log'), 8192)).trim().split('\n');
            // The runner writes one waiting line and at most one terminal line.
            // A partial write is not a successful/failed execution record.
            if (lines.length < 1 || lines.length > 2) throw new Error('INVALID_JOB');
            const waiting = waitingSchema.parse(JSON.parse(lines[0]!));
            if (Date.parse(waiting.startsAt) !== Date.parse(launch.startAt)) throw new Error('INVALID_JOB');
            const terminal = lines.length === 2 ? terminalSchema.parse(JSON.parse(lines[1]!)) : null;
            if (terminal && 'errorSamples' in terminal && terminal.errorSamples > terminal.samples)
              throw new Error('INVALID_JOB');
            const job = observationJobSchema.parse({
              id: entry.name,
              startsAt: launch.startAt,
              launchedAt: launch.launchedAt,
              instrument,
              requestedSamples: launch.samples,
              intervalSeconds: launch.intervalSeconds,
              state: terminal
                ? 'code' in terminal
                  ? 'failed'
                  : terminal.state
                : Date.parse(asOf) < Date.parse(launch.startAt)
                  ? 'scheduled'
                  : 'awaiting-result',
              failureCode: terminal && 'code' in terminal ? terminal.code : null,
              reportId: terminal && 'runId' in terminal ? terminal.runId : null,
              recordedSamples: terminal && 'samples' in terminal ? terminal.samples : null,
              executionEnabled: false,
            });
            if ((await realpath(folder)) !== join(canonical, entry.name) || (await realpath(root)) !== canonical)
              throw new Error('INVALID_JOB');
            jobs.push(job);
          } catch {
            rejectedCount++;
            if (limited) break;
          }
        }
      } catch (error) {
        if (!missing(error)) throw new Error('OBSERVATION_JOBS_UNAVAILABLE');
      }
      jobs.sort((a, b) => Date.parse(b.startsAt) - Date.parse(a.startsAt) || a.id.localeCompare(b.id));
      return observationJobsSchema.parse({ asOf, jobs, rejectedCount, limited });
    },
  };
}
