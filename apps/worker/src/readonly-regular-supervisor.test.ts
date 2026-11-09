import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { contentHash } from '@hth/database';
import { marketTradingDate } from '@hth/trading';
import { aggregateObservationRecords } from './observation-evidence.js';
import { fingerprintObservationBuild } from './readonly-process-check.js';
import type { ObservationChildLauncher } from './readonly-process-check.js';
import { runReadonlySupervisor } from './readonly-observation-supervisor.js';
import { verifyRegularSupervisionLink } from './readonly-supervision-status.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'regular-supervisor-')));
  roots.push(root);
  for (const dir of [
    'apps/worker/dist',
    'packages/contracts/dist',
    'packages/broker/dist',
    'packages/trading/dist',
    'packages/database/dist',
  ])
    await mkdir(join(root, dir), { recursive: true });
  await writeFile(join(root, 'pnpm-lock.yaml'), 'synthetic-test-build');
  const clock = { now: Date.now() - 1000 },
    start = clock.now;
  const jobId = 'us-' + marketTradingDate(start, 'US');
  const args = [
    '--source=market',
    '--symbol=US:AAPL',
    '--kind=regular',
    `--job-id=${jobId}`,
    `--start-at=${new Date(start).toISOString()}`,
    `--deadline=${new Date(start + 1500000).toISOString()}`,
    '--interval-seconds=10',
    `--session-start=${new Date(start - 60000).toISOString()}`,
    `--session-end=${new Date(start + 7200000).toISOString()}`,
  ];
  const preview = await runReadonlySupervisor(args, {}, root, new AbortController().signal);
  if (!('planHash' in preview)) throw Error('NO_PREVIEW');
  return {
    root,
    clock,
    start,
    jobId,
    args: [
      ...args,
      '--execute',
      `--plan-hash=${preview.planHash}`,
      `--build-hash=${await fingerprintObservationBuild(root)}`,
    ],
  };
}
// Fabricated market metadata only. No process or broker transport is launched.
async function evidence(parent: string, start: number, variant: string) {
  const id = randomUUID(),
    folder = join(parent, id);
  await mkdir(folder);
  const instrument = { market: 'US' as const, symbol: 'AAPL' };
  const manifest = {
    formatVersion: 'market-observation-v1',
    id,
    startedAt: new Date(start).toISOString(),
    mode: 'paper',
    assessmentScope: 'market-data-only',
    executionEnabled: false,
    policyVersion: 'market-data-v1',
    source: 'toss-readonly',
    instruments: [instrument],
    samples: 60,
    intervalMs: 10000,
    timeoutMs: 10000,
  };
  const records = Array.from({ length: 60 }, (_, i) => {
    const time = start + i * 11000 + (variant === 'gap' && i >= 30 ? 60000 : 0),
      blocked = variant === 'blocked' && i === 20;
    return {
      index: i + 1,
      startedAt: new Date(time).toISOString(),
      finishedAt: new Date(time + 1000).toISOString(),
      durationMs: 1000,
      error: null,
      instruments: [
        {
          instrument,
          state: blocked ? ('blocked' as const) : ('healthy' as const),
          blockers: blocked ? ['QUOTE_STALE' as const] : [],
          quoteTimestamp: new Date(time).toISOString(),
          quoteAgeMs: 0,
          quoteRegressed: false,
          latestCandleAt: new Date(time - 120000).toISOString(),
          closedCandles: 21,
          pendingCandles: 1,
          blockedCandles: 0,
        },
      ],
    };
  });
  const journal = records.map((record) => JSON.stringify(record)).join('\n') + '\n';
  const finishedAt = records.at(-1)!.finishedAt;
  const terminal = {
    ...manifest,
    finishedAt,
    journalSha256: variant === 'hash' ? '0'.repeat(64) : createHash('sha256').update(journal).digest('hex'),
    summary: aggregateObservationRecords(records, 'completed'),
  };
  const zero = { started: 0, succeeded: 0, failed: 0, cancelled: 0 };
  const token = {
    formatVersion: 'observation-token-lifecycle-v1',
    runId: id,
    source: 'toss-readonly',
    manifestHash: contentHash(manifest),
    snapshot: {
      formatVersion: 'toss-token-lifecycle-v1',
      capturedAt: finishedAt,
      clockUnverified: false,
      counters: { initial: zero, expiry: zero, unauthorized: zero },
      inFlight: 0,
      limited: false,
      events: [],
    },
  };
  for (const [name, value] of [
    ['manifest.json', manifest],
    ['summary.json', terminal],
    ['token-lifecycle.json', { ...token, hash: contentHash(token) }],
  ] as const)
    await writeFile(join(folder, name), JSON.stringify(value));
  await writeFile(join(folder, 'samples.jsonl'), journal);
  return Date.parse(finishedAt) + 1000;
}
it.each(['valid', 'blocked', 'gap', 'hash'])(
  '정규장 유한 감독은 가짜 60표본 %s와 정상 종료를 검증한다',
  async (variant) => {
    const f = await fixture();
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('NETWORK_FORBIDDEN'));
    const launch = vi.fn<ObservationChildLauncher>((_command, args, options) => {
      expect(args).toContain('--regular-only');
      expect(args).not.toEqual(expect.arrayContaining([expect.stringMatching(/^--expected-session-boundary=/)]));
      expect(options.env).not.toHaveProperty('TOSS_CLIENT_SECRET');
      const child = new EventEmitter() as ChildProcess;
      child.kill = vi.fn(() => true);
      const parent = args.find((arg) => arg.startsWith('--output='))!.slice(9);
      void evidence(parent, f.start, variant)
        .then((now) => {
          f.clock.now = now;
          child.emit('close', 0, null);
        })
        .catch(() => child.emit('error', new Error('FIXTURE_FAILED')));
      return child;
    });
    const result = await runReadonlySupervisor(f.args, {}, f.root, new AbortController().signal, {
      launch,
      now: () => f.clock.now,
      pollMs: 5,
    });
    expect(result).toMatchObject({
      state: variant === 'valid' ? 'observation-completed' : 'failed',
      childCleanupConfirmed: true,
      forced: false,
      automaticRetry: false,
      executionEnabled: false,
      canResume: false,
    });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(network).not.toHaveBeenCalled();
    if (!('id' in result)) throw Error('NO_RESULT');
    const request = JSON.parse(
      await readFile(join(f.root, '.local-data/readonly-supervisions', result.id, 'request.json'), 'utf8'),
    );
    if (variant === 'valid')
      expect(
        verifyRegularSupervisionLink(
          result.id,
          { request, result: { ...result, hash: contentHash(result) } },
          f.clock.now,
          f.jobId,
        ).job,
      ).toMatchObject({ id: f.jobId, requestedSamples: 60, state: 'completed' });
    else expect(result.evidence).toBeNull();
  },
  10000,
);
it('기존 미확인 예약은 정규장 모드도 자식·감독 폴더 생성 전에 차단한다', async () => {
  const f = await fixture(),
    launch = vi.fn();
  const directory = join(f.root, '.local-data/paper-validation-runs', randomUUID());
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'result.json'), '{}');
  await expect(
    runReadonlySupervisor(f.args, {}, f.root, new AbortController().signal, { launch, now: () => f.clock.now }),
  ).rejects.toThrow('SUPERVISOR_RESERVATIONS_UNVERIFIED');
  expect(launch).not.toHaveBeenCalled();
  expect(await readdir(join(f.root, '.local-data'))).toEqual(['paper-validation-runs']);
});
