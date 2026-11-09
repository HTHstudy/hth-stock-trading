import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { contentHash } from '@hth/database';
import { continuationFixture } from '../test/paper-continuation-fixture.js';
import { paperReviewCheckpoint, reviewPaperCheckpoints } from './paper-review.js';
import {
  readPaperContinuation,
  verifyPaperContinuationBaseline,
  verifyPaperContinuationBundle,
  verifyPaperContinuationEvents,
} from './paper-continuation.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
it('후속 준비 단계에는 지정한 자체 이력만 허용하고 version 없는 거부 이력도 차단한다', () => {
  const f = continuationFixture(),
    before = f.bundle.after;
  const kinds = {
    unchanged: [],
    'daily-review': ['LEASE_ACQUIRED', 'DAILY_REVIEW_COMPLETED', 'LEASE_RELEASED'],
    'stopped-observation': [
      'LEASE_ACQUIRED',
      'WORKER_RECOVERED',
      'ACCOUNT_OBSERVED',
      'ACCOUNT_OBSERVED',
      'LEASE_RELEASED',
      'STRATEGY_DIAGNOSED',
    ],
    'before-resume': ['LEASE_ACQUIRED', 'WORKER_RECOVERED', 'ACCOUNT_OBSERVED'],
  } as const;
  for (const phase of ['unchanged', 'daily-review', 'stopped-observation', 'before-resume'] as const) {
    const snapshot = structuredClone(before.snapshot);
    snapshot.events.push(
      ...kinds[phase].map((kind, index) => ({ key: contentHash(phase + index), kind, createdAt: f.context.asOf })),
    );
    const valid = paperReviewCheckpoint(snapshot);
    expect(verifyPaperContinuationEvents(before, valid, phase)).toBe(contentHash(snapshot.events));
    snapshot.events.push({ key: contentHash(phase + '-rejected'), kind: 'OTHER', createdAt: f.context.asOf });
    expect(() => verifyPaperContinuationEvents(before, paperReviewCheckpoint(snapshot), phase)).toThrow(
      'PAPER_CONTINUATION_INVALID',
    );
    snapshot.events.pop();
    snapshot.events.shift();
    expect(() => verifyPaperContinuationEvents(before, paperReviewCheckpoint(snapshot), phase)).toThrow(
      'PAPER_CONTINUATION_INVALID',
    );
  }
});
it('과거 매수·원가·비용·소유권을 유지한 대사와 독립 종료 증거를 연결한다', () => {
  const f = continuationFixture(),
    verified = verifyPaperContinuationBundle(f.bundle, f.context);
  expect(verified.baseline.snapshot.intents).toHaveLength(1);
  expect(verified.baseline.snapshot.fills).toHaveLength(1);
  expect(verified).toMatchObject({
    parentRunId: f.context.parentRunId,
    parentLaunchId: f.context.parentLaunchId,
    executionEnabled: false,
    canResume: false,
  });
  const current = paperReviewCheckpoint({ ...f.bundle.after.snapshot, asOf: f.context.asOf });
  expect(verifyPaperContinuationBaseline(verified.baseline, current)).toMatchObject({
    unchanged: true,
    executionEnabled: false,
    canResume: false,
  });
  expect(current.snapshot.cash.KRW).toBe('8999');
  expect(current.snapshot.basis[0]?.amount).toBe('1001');
});
it('이전 계좌·원장·손실 날짜·제어·이력이 바뀌면 읽기 시각만 제외하고 거부한다', () => {
  for (const change of [
    (s: ReturnType<typeof continuationFixture>['bundle']['after']['snapshot']) => {
      s.cash.KRW = '10000';
    },
    (s: ReturnType<typeof continuationFixture>['bundle']['after']['snapshot']) => {
      s.version++;
    },
    (s: ReturnType<typeof continuationFixture>['bundle']['after']['snapshot']) => {
      s.epoch++;
    },
    (s: ReturnType<typeof continuationFixture>['bundle']['after']['snapshot']) => {
      s.dailyPnl.KRW.netPnl = '0.01';
    },
    (s: ReturnType<typeof continuationFixture>['bundle']['after']['snapshot']) => {
      s.dailyPnl.KRW.tradingDate = '2026-11-03';
    },
    (s: ReturnType<typeof continuationFixture>['bundle']['after']['snapshot']) => {
      s.basis[0]!.amount = '1000';
    },
    (s: ReturnType<typeof continuationFixture>['bundle']['after']['snapshot']) => {
      s.intents = [];
      s.fills = [];
    },
    (s: ReturnType<typeof continuationFixture>['bundle']['after']['snapshot']) => {
      s.positions[0]!.manualQuantity = '1';
    },
    (s: ReturnType<typeof continuationFixture>['bundle']['after']['snapshot']) => {
      s.scope = 'a'.repeat(64);
    },
    (s: ReturnType<typeof continuationFixture>['bundle']['after']['snapshot']) => {
      s.leasePresent = true;
    },
  ]) {
    const f = continuationFixture(),
      current = structuredClone(f.bundle.after.snapshot);
    current.asOf = f.context.asOf;
    change(current);
    expect(() => verifyPaperContinuationBaseline(f.bundle.after, paperReviewCheckpoint(current))).toThrow(
      /^PAPER_CONTINUATION_INVALID$/,
    );
  }
});
it('연결 오류·실패/강제 종료·취소·미래 증거·대사 변조를 후속 권한으로 바꾸지 않는다', () => {
  const valid = continuationFixture();
  const cases = [
    { ...valid.bundle, exit: { ...valid.bundle.exit, forced: true } },
    { ...valid.bundle, exit: { ...valid.bundle.exit, signal: 'SIGTERM' } },
    { ...valid.bundle, exit: { ...valid.bundle.exit, exitCode: 2 } },
    { ...valid.bundle, exit: { ...valid.bundle.exit, nonce: '12345678-1234-4234-8234-123456789012' } },
    { ...valid.bundle, result: { ...valid.bundle.result, state: 'stopped-before-run-or-failed' } },
    { ...valid.bundle, review: { ...valid.bundle.review, hash: 'a'.repeat(64) } },
    { ...valid.bundle, after: { ...valid.bundle.after, hash: 'a'.repeat(64) } },
    { ...valid.bundle, launch: { ...valid.bundle.launch, runId: '12345678-1234-4234-8234-123456789012' } },
  ];
  for (const input of cases)
    expect(() => verifyPaperContinuationBundle(input, valid.context)).toThrow('PAPER_CONTINUATION_INVALID');
  expect(() => verifyPaperContinuationBundle(valid.bundle, { ...valid.context, market: 'US' })).toThrow(
    'PAPER_CONTINUATION_INVALID',
  );
  expect(() =>
    verifyPaperContinuationBundle(valid.bundle, { ...valid.context, asOf: valid.bundle.before.snapshot.asOf }),
  ).toThrow('PAPER_CONTINUATION_INVALID');
  const forged = structuredClone(valid.bundle);
  forged.exit.forced = true;
  const { hash: ignored, ...body } = forged.exit;
  expect(ignored).toMatch(/^[a-f0-9]{64}$/);
  forged.exit.hash = contentHash(body);
  expect(() => verifyPaperContinuationBundle(forged, valid.context)).toThrow('PAPER_CONTINUATION_INVALID');
});
async function saved() {
  const root = await mkdtemp(join(tmpdir(), 'paper-continuation-'));
  roots.push(root);
  const f = continuationFixture();
  for (const [kind, id, names] of [
    ['paper-validation-runs', f.context.parentRunId, ['request', 'result', 'before', 'after', 'review']],
    ['paper-validation-processes', f.context.parentLaunchId, ['launch', 'exit']],
  ] as const) {
    const dir = join(root, '.local-data', kind, id);
    await mkdir(dir, { recursive: true });
    for (const name of names) await writeFile(join(dir, name + '.json'), JSON.stringify(f.bundle[name]));
  }
  return { root, ...f };
}
it('고정 UUID 파일만 읽고 바이트 변경·누락·symlink·scope 이탈을 차단한다', async () => {
  const f = await saved(),
    before = await readFile(join(f.root, '.local-data/paper-validation-runs', f.context.parentRunId, 'after.json'));
  const proof = await readPaperContinuation(f.root, f.context);
  expect((await readPaperContinuation(f.root, f.context, proof.evidenceHash)).evidenceHash).toBe(proof.evidenceHash);
  const file = join(f.root, '.local-data/paper-validation-runs', f.context.parentRunId, 'after.json');
  expect(await readFile(file)).toEqual(before);
  await writeFile(file, Buffer.concat([before, Buffer.from('\n')]));
  await expect(readPaperContinuation(f.root, f.context, proof.evidenceHash)).rejects.toThrow(
    'PAPER_CONTINUATION_INVALID',
  );
  await rm(file);
  await symlink(join(f.root, 'private-key'), file);
  await expect(readPaperContinuation(f.root, f.context)).rejects.toThrow('PAPER_CONTINUATION_INVALID');
  await expect(readPaperContinuation(f.root, { ...f.context, parentRunId: '../../private-key' })).rejects.toThrow(
    /^PAPER_CONTINUATION_INVALID$/,
  );
});
it('조회 CLI는 서버 환경·DB·계좌·실행 파일 생성 없이 hash만 확인한다', async () => {
  const f = await saved(),
    before = await readdir(join(f.root, '.local-data/paper-validation-runs'));
  const execute = promisify(execFile);
  const result = await execute(
    process.execPath,
    [
      resolve('infra/authorized-paper-validation.mjs'),
      '--market=KR',
      `--build-root=${resolve('.')}`,
      '--inspect-continuation',
      `--continue-from=${f.context.parentRunId}`,
      `--continuation-launch=${f.context.parentLaunchId}`,
    ],
    { cwd: f.root, env: { TRADING_MODE: 'paper' }, timeout: 10000 },
  );
  const output = JSON.parse(result.stdout);
  expect(output).toMatchObject({
    state: 'continuation-reviewed',
    dbAccessed: false,
    executionEnabled: false,
    canResume: false,
  });
  expect(output.evidenceHash).toMatch(/^[a-f0-9]{64}$/);
  expect(result.stdout).not.toContain('8999');
  expect(result.stdout).not.toContain('scope');
  expect(await readdir(join(f.root, '.local-data/paper-validation-runs'))).toEqual(before);
  await expect(readFile(join(f.root, '.env'))).rejects.toMatchObject({ code: 'ENOENT' });
}, 20000);

it('실행의 후속 인자는 전체를 요구하며 inspect와 실행 혼합을 I/O 전에 차단한다', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paper-continuation-flags-'));
  roots.push(root);
  const f = continuationFixture();
  const execute = promisify(execFile);
  const flags = [`--continue-from=${f.context.parentRunId}`, `--continuation-launch=${f.context.parentLaunchId}`];
  for (const extra of [
    flags,
    [...flags, '--inspect-continuation'],
    ['--continue-from=../../private-key'],
    ['--continue-from='],
    ['--continue-from=', '--continuation-launch=', '--continuation-hash='],
  ]) {
    await expect(
      execute(
        process.execPath,
        [resolve('infra/authorized-paper-validation.mjs'), '--market=KR', '--run', '--resume-authorized', ...extra],
        { cwd: root, env: {}, timeout: 10000 },
      ),
    ).rejects.toMatchObject({ stderr: expect.stringContaining('PAPER_CONTINUATION_INVALID') });
    expect(await readdir(root)).toEqual([]);
  }
}, 20000);

function rebuild(f: ReturnType<typeof continuationFixture>) {
  f.bundle.after = paperReviewCheckpoint(f.bundle.after.snapshot);
  const report = reviewPaperCheckpoints(f.bundle.before, f.bundle.after, f.bundle.review.report.asOf);
  f.bundle.review = { ...f.bundle.review, report, hash: contentHash(report) };
  f.bundle.result = {
    ...f.bundle.result,
    state: 'completed-with-incomplete-review',
    verdict: report.verdict,
    intents: f.bundle.after.snapshot.intents.length,
    fills: f.bundle.after.snapshot.fills.length,
  };
  const { hash: previous, ...exit } = f.bundle.exit;
  expect(previous).toMatch(/^[a-f0-9]{64}$/);
  f.bundle.exit = { ...exit, exitCode: 2, hash: contentHash({ ...exit, exitCode: 2 }) };
}
it('체결이 없었던 이전 구간은 일관성만 인정하고 체결 경로 미검증을 유지한다', () => {
  const f = continuationFixture(),
    after = f.bundle.after.snapshot;
  after.cash = { ...f.bundle.before.snapshot.cash };
  after.positions = [];
  after.basis = [];
  after.intents = [];
  after.fills = [];
  after.reservations = [];
  after.events = after.events.filter((event) => !['INTENT_RECORDED', 'PAPER_FILL_RECORDED'].includes(event.kind));
  rebuild(f);
  expect(f.bundle.review.report.verdict).toBe('incomplete');
  expect(verifyPaperContinuationBundle(f.bundle, f.context)).toMatchObject({
    executionEnabled: false,
    canResume: false,
  });
  expect(f.bundle.review.report.checks.fillPath).toBe('unverified');
});
it('대사 hash를 다시 계산해도 외부 변경·복수 lease의 불확실성을 허용하지 않는다', () => {
  for (const kind of ['OTHER', 'LEASE_ACQUIRED'] as const) {
    const f = continuationFixture();
    f.bundle.after.snapshot.events.push({
      key: contentHash('extra-' + kind),
      kind,
      createdAt: '2026-11-02T00:01:20.000000Z',
    });
    rebuild(f);
    expect(f.bundle.review.report.verdict).toBe('incomplete');
    expect(() => verifyPaperContinuationBundle(f.bundle, f.context)).toThrow('PAPER_CONTINUATION_INVALID');
  }
});
