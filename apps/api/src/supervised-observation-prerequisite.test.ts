import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { contentHash } from '@hth/database';
import { aggregateObservationRecords } from '@hth/worker/observation-evidence';
import { paperPrerequisiteMaxAgeMs, verifyPaperPrerequisite } from '@hth/worker/paper-validation-guards';
import { observationTokenLifecycleSchema } from '@hth/contracts';
import type { ObservationRecord, TokenLifecycleSnapshot } from '@hth/contracts';
import * as reports from './observation-reports.js';
import { createSupervisedObservationPrerequisite } from './supervised-observation-prerequisite.js';

const roots: string[] = [];
const base = Date.parse('2026-11-09T01:00:00Z');
const at = (offset: number) => new Date(base + offset).toISOString();
const invalid = 'SUPERVISED_PREREQUISITE_INVALID';
const signed = <T extends object>(body: T) => ({ ...body, hash: contentHash(body) });
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'hth-supervised-prerequisite-'));
  roots.push(root);
  const supervisionId = randomUUID(),
    reportId = randomUUID(),
    jobId = 'kr-2026-11-09';
  const supervision = join(root, '.local-data', 'readonly-supervisions', supervisionId);
  const observation = join(supervision, 'observation', reportId);
  await mkdir(observation, { recursive: true, mode: 0o700 });
  const instrument = { market: 'KR' as const, symbol: '005930' };
  // Hand-built synthetic provenance; never a real market observation or authorization.
  const plan = {
    formatVersion: 'readonly-validation-plan-v1',
    kind: 'regular',
    state: 'prepared',
    startsAt: at(0),
    deadline: at(1_800_000),
    targetThrough: at(590_000),
    samples: 60,
    intervalSeconds: 10,
    sampleTimeoutMs: 10_000,
    minimumSamplingSpanMs: 590_000,
    startupAllowanceMs: 30_000,
    cleanupAllowanceMs: 60_000,
    plannedBudgetMs: 1_280_000,
    estimatedBudgetEndsAt: at(1_280_000),
    sourceMethodCallsWithoutRetries: 300,
    httpRequestCountKnown: false,
    blockers: [],
    reservedWindowCount: 0,
    reservedWindows: [],
    observedTtlSeconds: null,
    boundaryAt: null,
    sessionStartsAt: at(-60_000),
    sessionEndsAt: at(3_600_000),
    regularOnly: true,
    tokenLifecycle: true,
    requiresDeadlineSupervisor: true,
    requiresFreshCalendar: true,
    requiresActualTtlReview: false,
    scheduled: false,
    executionEnabled: false,
    canResume: false,
  };
  const binding = { plan, source: 'market', instrument, observationJobId: jobId };
  const request = {
    formatVersion: 'readonly-supervision-request-v1',
    id: supervisionId,
    service: 'readonly-observation-supervisor',
    ...binding,
    planHash: contentHash(binding),
    buildHash: 'a'.repeat(64),
    requestedAt: at(-1000),
    executionEnabled: false,
    canResume: false,
    automaticRetry: false,
  };
  const manifest = {
    formatVersion: 'market-observation-v1',
    id: reportId,
    startedAt: at(0),
    mode: 'paper',
    assessmentScope: 'market-data-only',
    executionEnabled: false,
    policyVersion: 'market-data-v1',
    source: 'toss-readonly',
    instruments: [instrument],
    samples: 60,
    intervalMs: 10_000,
    timeoutMs: 10_000,
  };
  const records: ObservationRecord[] = Array.from({ length: 60 }, (_, index) => ({
    index: index + 1,
    startedAt: at(index * 10_000),
    finishedAt: at(index * 10_000 + 1000),
    durationMs: 1000,
    error: null,
    instruments: [
      {
        instrument,
        state: 'healthy',
        blockers: [],
        quoteTimestamp: at(index * 10_000),
        quoteAgeMs: 1000,
        quoteRegressed: false,
        latestCandleAt: at(index * 10_000 - 60_000),
        closedCandles: 20,
        pendingCandles: 1,
        blockedCandles: 0,
      },
    ],
  }));
  const journal = records.map((record) => JSON.stringify(record)).join('\n') + '\n';
  const artifact = {
    ...manifest,
    finishedAt: at(592_000),
    journalSha256: createHash('sha256').update(journal).digest('hex'),
    summary: aggregateObservationRecords(records, 'completed'),
  };
  const result = {
    formatVersion: 'readonly-supervision-result-v1',
    id: supervisionId,
    service: request.service,
    source: 'market',
    state: 'observation-completed',
    stage: 'verify',
    code: null,
    planHash: request.planHash,
    buildHash: request.buildHash,
    forced: false,
    childCleanupConfirmed: true,
    evidence: { id: reportId, samples: 60, healthy: 60, closed: 0, blocked: 0, journalSha256: artifact.journalSha256 },
    tokenExpiryVerified: false,
    sessionBoundaryVerified: false,
    paperLedgerCompared: false,
    finishedAt: at(600_000),
    executionEnabled: false,
    canResume: false,
    automaticRetry: false,
  };
  const counts = { started: 0, succeeded: 0, failed: 0, cancelled: 0 };
  const snapshot: TokenLifecycleSnapshot = {
    formatVersion: 'toss-token-lifecycle-v1',
    capturedAt: at(595_000),
    clockUnverified: false,
    counters: { initial: { ...counts }, expiry: { ...counts }, unauthorized: { ...counts } },
    inFlight: 0,
    limited: false,
    events: [],
  };
  const token = {
    formatVersion: 'observation-token-lifecycle-v1',
    runId: reportId,
    source: 'toss-readonly',
    manifestHash: contentHash(manifest),
    snapshot,
  };
  async function save() {
    token.manifestHash = contentHash(manifest);
    await writeFile(join(supervision, 'request.json'), JSON.stringify(request), { mode: 0o600 });
    await writeFile(join(supervision, 'result.json'), JSON.stringify(signed(result)), { mode: 0o600 });
    await writeFile(join(observation, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
    await writeFile(join(observation, 'summary.json'), JSON.stringify({ ...artifact, ...manifest }), { mode: 0o600 });
    await writeFile(join(observation, 'samples.jsonl'), journal, { mode: 0o600 });
    await writeFile(join(observation, 'token-lifecycle.json'), JSON.stringify(signed(token)), { mode: 0o600 });
  }
  await save();
  const get = () => createSupervisedObservationPrerequisite(root, () => base + 610_000).get(supervisionId, jobId);
  return {
    root,
    supervisionId,
    reportId,
    jobId,
    supervision,
    observation,
    request,
    result,
    manifest,
    records,
    artifact,
    token,
    save,
    get,
  };
}

it('실제 순수 verifier와 전체 journal reader로 60회 증거를 연결하며 파일을 변경하지 않는다', async () => {
  const f = await fixture();
  const files = ['request.json', 'result.json'].map((name) => join(f.supervision, name));
  files.push(
    ...['manifest.json', 'summary.json', 'samples.jsonl', 'token-lifecycle.json'].map((name) =>
      join(f.observation, name),
    ),
  );
  const before = await Promise.all(files.map((path) => readFile(path, 'utf8')));
  const value = await f.get();
  expect(value).toMatchObject({
    job: { id: f.jobId, reportId: f.reportId, state: 'completed', executionEnabled: false },
    evidence: {
      report: { recordedSamples: 60, samplesLimited: true, summary: { healthy: 60 } },
      sampleRange: { startedAt: at(0), finishedAt: at(591_000) },
    },
    supervisionHash: contentHash({ request: f.request, result: signed(f.result) }),
    sessionStartsAt: at(-60_000),
    sessionEndsAt: at(3_600_000),
  });
  expect(value.evidence.report.recentSamples).toHaveLength(50);
  expect(value.evidence.report.recentSamples[0]?.index).toBe(11);
  const context = {
    instrument: f.request.instrument,
    sessionStartsAt: value.sessionStartsAt,
    sessionEndsAt: value.sessionEndsAt,
    asOf: at(610_000),
  };
  const prerequisite = verifyPaperPrerequisite(value.job, value.evidence, context);
  expect(prerequisite).toMatchObject({
    formatVersion: 'paper-prerequisite-check-v1',
    instrument: f.request.instrument,
    sampleRange: value.evidence.sampleRange,
    reportFinishedAt: f.artifact.finishedAt,
    maximumAgeMs: 15 * 60_000,
    actualSessionVerified: false,
    executionEnabled: false,
  });
  expect(prerequisite.evidenceHash).toMatch(/^[a-f0-9]{64}$/);
  const finished = Date.parse(f.artifact.finishedAt);
  expect(
    verifyPaperPrerequisite(value.job, value.evidence, {
      ...context,
      asOf: new Date(finished + paperPrerequisiteMaxAgeMs).toISOString(),
    }).evidenceHash,
  ).toBe(prerequisite.evidenceHash);
  expect(() =>
    verifyPaperPrerequisite(value.job, value.evidence, {
      ...context,
      asOf: new Date(finished + paperPrerequisiteMaxAgeMs + 1).toISOString(),
    }),
  ).toThrow(new Error('PREREQUISITE_FAILED'));
  expect(Object.keys(value).sort()).toEqual(['evidence', 'job', 'sessionEndsAt', 'sessionStartsAt', 'supervisionHash']);
  expect(JSON.stringify(value)).not.toMatch(/account|PID|request\.json|token-lifecycle/);
  expect(await Promise.all(files.map((path) => readFile(path, 'utf8')))).toEqual(before);
});

it.each(['id', 'job', 'missing', 'result-hash', 'journal-hash', 'token-hash'])(
  '%s 오류는 단일 generic 오류다',
  async (kind) => {
    const f = await fixture();
    let get = f.get;
    if (kind === 'id') get = () => createSupervisedObservationPrerequisite(f.root).get('../PRIVATE_ACCOUNT', f.jobId);
    if (kind === 'job')
      get = () => createSupervisedObservationPrerequisite(f.root).get(f.supervisionId, 'us-2026-11-09');
    if (kind === 'missing') await rm(join(f.supervision, 'result.json'));
    if (kind === 'result-hash')
      await writeFile(
        join(f.supervision, 'result.json'),
        JSON.stringify({ ...signed(f.result), hash: '0'.repeat(64) }),
      );
    if (kind === 'journal-hash') await writeFile(join(f.observation, 'samples.jsonl'), 'PRIVATE_ACCOUNT');
    if (kind === 'token-hash')
      await writeFile(
        join(f.observation, 'token-lifecycle.json'),
        JSON.stringify({ ...signed(f.token), hash: '0'.repeat(64) }),
      );
    await expect(get()).rejects.toThrow(new Error(invalid));
  },
);

it.each([
  'source',
  'samples',
  'interval',
  'timeout',
  'instrument',
  'manifest-id',
  'manifest-start-before-job',
  'manifest-before-launch',
  'finished-before',
  'finished-after',
  'finished-future',
  'healthy',
  'error',
  'closed',
  'blocked',
  'regressions',
])('%s가 link 또는 완료 조건과 다르면 거부한다', async (kind) => {
  const f = await fixture();
  if (kind === 'source') f.manifest.source = 'synthetic-only';
  if (kind === 'samples') f.manifest.samples = 59;
  if (kind === 'interval') f.manifest.intervalMs = 20_000;
  if (kind === 'timeout') f.manifest.timeoutMs = 9999;
  if (kind === 'instrument') f.manifest.instruments[0]!.symbol = 'OTHER';
  if (kind === 'manifest-id') f.manifest.id = randomUUID();
  if (kind === 'manifest-start-before-job') f.manifest.startedAt = at(-1);
  if (kind === 'manifest-before-launch') f.request.requestedAt = at(1);
  if (kind === 'finished-before') f.artifact.finishedAt = at(-1);
  if (kind === 'finished-after') f.artifact.finishedAt = at(600_001);
  if (kind === 'finished-future') f.artifact.finishedAt = at(620_000);
  if (kind === 'healthy') f.artifact.summary.healthy--;
  if (kind === 'error') f.artifact.summary.errorSamples++;
  if (kind === 'closed') f.artifact.summary.closed++;
  if (kind === 'blocked') f.artifact.summary.blocked++;
  if (kind === 'regressions') f.artifact.summary.quoteRegressions++;
  await f.save();
  await expect(f.get()).rejects.toThrow(new Error(invalid));
});

it.each(['closed', 'blocked', 'error', 'regression'])(
  'journal과 집계 hash가 올바른 %s 품질 실패도 거부한다',
  async (kind) => {
    const f = await fixture();
    const record = f.records[0]!;
    if (kind === 'closed' || kind === 'blocked') record.instruments[0]!.state = kind;
    if (kind === 'error') {
      record.error = 'TIMEOUT';
      record.instruments = [];
    }
    if (kind === 'regression') record.instruments[0]!.quoteRegressed = true;
    const journal = f.records.map((item) => JSON.stringify(item)).join('\n') + '\n';
    f.artifact.summary = aggregateObservationRecords(f.records, 'completed');
    f.artifact.journalSha256 = createHash('sha256').update(journal).digest('hex');
    f.result.evidence.journalSha256 = f.artifact.journalSha256;
    await f.save();
    await writeFile(join(f.observation, 'samples.jsonl'), journal);
    const evidence = await reports
      .createObservationReports(join(f.supervision, 'observation'))
      .getWithSampleRange(f.reportId);
    expect(evidence.report.state).toBe('completed');
    await expect(f.get()).rejects.toThrow(new Error(invalid));
  },
);

it.each(['session-start', 'session-end', 'session-end-equal', 'job-start', 'middle-regression', 'gap'])(
  '최근 50회 밖 첫 표본을 포함한 전체 범위의 %s 경계를 검사한다',
  async (kind) => {
    const f = await fixture();
    if (kind === 'session-start') f.records[0]!.startedAt = at(-60_001);
    if (kind === 'job-start') f.records[0]!.startedAt = at(-1);
    if (kind === 'session-end') f.records[59]!.finishedAt = at(3_600_001);
    if (kind === 'session-end-equal') f.records[59]!.finishedAt = at(3_600_000);
    if (kind === 'middle-regression') f.records[5]!.startedAt = at(-10_000);
    if (kind === 'gap') {
      for (let index = 5; index < 10; index++) {
        f.records[index]!.startedAt = at(90_000 + (index - 5) * 1000);
        f.records[index]!.finishedAt = at(91_000 + (index - 5) * 1000);
      }
    }
    const journal = f.records.map((record) => JSON.stringify(record)).join('\n') + '\n';
    f.artifact.journalSha256 = createHash('sha256').update(journal).digest('hex');
    f.result.evidence.journalSha256 = f.artifact.journalSha256;
    await f.save();
    await writeFile(join(f.observation, 'samples.jsonl'), journal);
    await expect(f.get()).rejects.toThrow(new Error(invalid));
  },
);

it.each(['clock', 'limited', 'in-flight', 'late-capture', 'manifest-link', 'run-link'])(
  '토큰 %s 증거를 거부한다',
  async (kind) => {
    const f = await fixture();
    if (kind === 'clock') f.token.snapshot.clockUnverified = true;
    if (kind === 'limited') {
      f.token.snapshot.limited = true;
      f.token.snapshot.counters.initial = { started: 65, succeeded: 65, failed: 0, cancelled: 0 };
      f.token.snapshot.events = Array.from({ length: 64 }, (_, index) => [
        { attempt: index + 2, trigger: 'initial' as const, phase: 'started' as const, at: at(0) },
        {
          attempt: index + 2,
          trigger: 'initial' as const,
          phase: 'succeeded' as const,
          at: at(0),
          expiresInSeconds: 3600,
          validityBaseAt: at(0),
          refreshAt: at(3_540_000),
          expiresAt: at(3_600_000),
        },
      ]).flat();
    }
    if (kind === 'in-flight') {
      f.token.snapshot.inFlight = 1;
      f.token.snapshot.counters.initial.started = 1;
      f.token.snapshot.events = [{ attempt: 1, trigger: 'initial', phase: 'started', at: at(0) }];
    }
    if (kind === 'late-capture') f.token.snapshot.capturedAt = at(600_001);
    if (kind === 'run-link') f.token.runId = randomUUID();
    observationTokenLifecycleSchema.parse(signed(f.token));
    await f.save();
    if (kind === 'manifest-link')
      await writeFile(
        join(f.observation, 'token-lifecycle.json'),
        JSON.stringify(signed({ ...f.token, manifestHash: '0'.repeat(64) })),
      );
    await expect(f.get()).rejects.toThrow(new Error(invalid));
  },
);

it.each([
  'local',
  'root',
  'supervision',
  'observations',
  'observation',
  'request',
  'result',
  'token',
  'manifest',
  'journal',
])('%s symlink를 거부한다', async (kind) => {
  const f = await fixture();
  const paths: Record<string, string> = {
    local: join(f.root, '.local-data'),
    root: join(f.root, '.local-data', 'readonly-supervisions'),
    supervision: f.supervision,
    observations: join(f.supervision, 'observation'),
    observation: f.observation,
    request: join(f.supervision, 'request.json'),
    result: join(f.supervision, 'result.json'),
    token: join(f.observation, 'token-lifecycle.json'),
    manifest: join(f.observation, 'manifest.json'),
    journal: join(f.observation, 'samples.jsonl'),
  };
  const path = paths[kind]!;
  const target = join(f.root, 'private-target');
  await rename(path, target);
  await symlink(target, path);
  await expect(f.get()).rejects.toThrow(new Error(invalid));
});

it.each(['request', 'result', 'token'])('%s 크기 초과·잘못된 JSON·비일반 파일을 거부한다', async (kind) => {
  const f = await fixture();
  const path = kind === 'token' ? join(f.observation, 'token-lifecycle.json') : join(f.supervision, `${kind}.json`);
  for (const data of [' '.repeat((kind === 'token' ? 128 : 64) * 1024 + 1), '{"PRIVATE_ACCOUNT":', 'null']) {
    await writeFile(path, data);
    await expect(f.get()).rejects.toThrow(new Error(invalid));
  }
  await rm(path);
  await mkdir(path);
  await expect(f.get()).rejects.toThrow(new Error(invalid));
});

it.each(['request', 'result', 'supervision', 'observation', 'journal'])(
  'reader 실행 도중 %s 교체를 재검사한다',
  async (kind) => {
    const f = await fixture();
    const original = reports.createObservationReports;
    vi.spyOn(reports, 'createObservationReports').mockImplementation((...args) => {
      const reader = original(...args);
      return {
        ...reader,
        async getWithSampleRange(id) {
          const value = await reader.getWithSampleRange(id);
          if (kind === 'request' || kind === 'result' || kind === 'journal') {
            const path =
              kind === 'journal' ? join(f.observation, 'samples.jsonl') : join(f.supervision, `${kind}.json`);
            const data = await readFile(path);
            await writeFile(path + '.replacement', data);
            await rename(path + '.replacement', path);
          } else {
            const path = kind === 'supervision' ? f.supervision : f.observation;
            await rename(path, path + '.moved');
            await rename(path + '.moved', path);
          }
          return value;
        },
      };
    });
    await expect(f.get()).rejects.toThrow(new Error(invalid));
  },
);

it.each(['evidence', 'state', 'gap', 'partial', 'last-recorded', 'last-successful', 'missing'])(
  'reader monitoring의 %s 조건을 helper에서도 거부한다',
  async (kind) => {
    const f = await fixture();
    const original = reports.createObservationReports;
    vi.spyOn(reports, 'createObservationReports').mockImplementation((...args) => {
      const reader = original(...args);
      return {
        ...reader,
        async getWithSampleRange(id) {
          const value = await reader.getWithSampleRange(id);
          const monitoring = value.report.monitoring!;
          if (kind === 'evidence') monitoring.evidence = 'provisional';
          if (kind === 'state') monitoring.state = 'clock-unverified';
          if (kind === 'gap') monitoring.gapCount = 1;
          if (kind === 'partial') monitoring.partialWrite = true;
          if (kind === 'last-recorded') monitoring.lastRecordedAt = at(590_000);
          if (kind === 'last-successful') monitoring.lastSuccessfulAt = at(590_000);
          if (kind === 'missing') value.report.monitoring = null;
          return value;
        },
      };
    });
    await expect(f.get()).rejects.toThrow(new Error(invalid));
  },
);

it('미래·비유한 조회 시각 및 없는 자료를 generic 실패로 처리한다', async () => {
  const f = await fixture();
  for (const time of [NaN, Infinity, base - 2000]) {
    await expect(
      createSupervisedObservationPrerequisite(f.root, () => time).get(f.supervisionId, f.jobId),
    ).rejects.toThrow(new Error(invalid));
  }
  await expect(
    createSupervisedObservationPrerequisite(join(f.root, 'missing')).get(f.supervisionId, f.jobId),
  ).rejects.toThrow(new Error(invalid));
});
