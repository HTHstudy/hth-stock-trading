import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { contentHash } from '@hth/database';
import { planReadonlyValidation } from './readonly-validation-plan.js';
import { createReadonlySupervisionStatus, summarizeReadonlySupervision } from './readonly-supervision-status.js';

const roots: string[] = [];
const start = Date.parse('2026-11-04T12:00:00Z');
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});
function fixture(kind: 'expiry' | 'session' = 'expiry', source: 'demo' | 'market' = 'demo') {
  const id = randomUUID();
  const plan = planReadonlyValidation({
    kind,
    startsAt: new Date(start).toISOString(),
    deadline: new Date(start + 900_000).toISOString(),
    intervalSeconds: 30,
    reservedWindows: [],
    ...(kind === 'expiry' ? { observedTtlSeconds: 1 } : { boundaryAt: new Date(start + 60_000).toISOString() }),
  });
  const binding = { plan, source, instrument: { market: 'KR', symbol: '005930' } };
  const request = {
    formatVersion: 'readonly-supervision-request-v1',
    id,
    service: 'readonly-observation-supervisor',
    ...binding,
    planHash: contentHash(binding),
    buildHash: 'a'.repeat(64),
    requestedAt: new Date(start - 1000).toISOString(),
    executionEnabled: false,
    canResume: false,
    automaticRetry: false,
  };
  const result = {
    formatVersion: 'readonly-supervision-result-v1',
    id,
    service: request.service,
    source,
    state: 'observation-completed',
    stage: 'verify',
    code: null as string | null,
    planHash: request.planHash,
    buildHash: request.buildHash,
    forced: false,
    childCleanupConfirmed: true,
    evidence: {
      id: randomUUID(),
      samples: plan.samples,
      healthy: plan.samples - 1,
      closed: 1,
      blocked: 0,
      journalSha256: 'b'.repeat(64),
    } as {
      id: string;
      samples: number;
      healthy: number;
      closed: number;
      blocked: number;
      journalSha256: string;
    } | null,
    tokenExpiryVerified: false,
    sessionBoundaryVerified: false,
    paperLedgerCompared: false,
    finishedAt: new Date(start + 600_000).toISOString(),
    executionEnabled: false,
    canResume: false,
    automaticRetry: false,
  };
  return { id, request, result };
}
function signed(body: Record<string, unknown>) {
  return { ...body, hash: contentHash(body) };
}
async function setup() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'readonly-supervision-status-'));
  roots.push(root);
  const f = fixture();
  const path = join(root, f.id);
  await mkdir(path);
  await writeFile(join(path, 'request.json'), JSON.stringify(f.request));
  return { ...f, root, path };
}

it('루트 누락과 빈 루트를 구분하며 조회가 파일을 만들지 않는다', async () => {
  const f = await setup();
  await rm(f.path, { recursive: true });
  expect(await createReadonlySupervisionStatus(join(f.root, 'missing')).list()).toMatchObject({
    availability: 'not-recorded',
    runs: [],
  });
  expect(await createReadonlySupervisionStatus(f.root).list()).toMatchObject({ availability: 'available', runs: [] });
});

it('종료가 없고 기한이 지나도 awaiting-result이며 프로세스 상태를 추정하지 않는다', async () => {
  const f = await setup();
  const before = await readFile(join(f.path, 'request.json'), 'utf8');
  const status = await createReadonlySupervisionStatus(f.root, () => start + 1000_000).list();
  expect(status).toMatchObject({ availability: 'available', rejectedCount: 0, processLivenessChecked: false });
  expect(status.runs[0]).toMatchObject({
    state: 'awaiting-result',
    deadlineElapsed: true,
    clockUnverified: false,
    stage: null,
    code: null,
    finishedAt: null,
    childCleanupConfirmed: null,
    resultHashVerified: false,
    executionEnabled: false,
    canResume: false,
  });
  expect(await readFile(join(f.path, 'request.json'), 'utf8')).toBe(before);
});

it.each(['expiry', 'session'] as const)('완료 %s 메타데이터만 반환하고 운영 검증은 false로 보존한다', async (kind) => {
  const f = fixture(kind, 'market');
  const value = summarizeReadonlySupervision(f.id, { request: f.request, result: signed(f.result) }, start + 700_000);
  expect(value).toMatchObject({
    state: 'observation-completed',
    resultHashVerified: true,
    samples: f.request.plan.samples,
    healthy: f.request.plan.samples - 1,
    closed: 1,
    blocked: 0,
    processLivenessChecked: false,
    observationEvidenceRecomputed: false,
    currentBuildChecked: false,
    tokenExpiryVerified: false,
    sessionBoundaryVerified: false,
    paperLedgerCompared: false,
  });
  expect(value).not.toHaveProperty('plan');
  expect(value).not.toHaveProperty('evidence');
  expect(value).not.toHaveProperty('journalSha256');
});

it('실패 기록은 완료로 바꾸지 않고 강제 정리 미확인을 유지한다', () => {
  const f = fixture();
  Object.assign(f.result, {
    state: 'failed',
    stage: 'observing',
    code: 'SUPERVISOR_FORCED_STOP',
    forced: true,
    childCleanupConfirmed: false,
    evidence: null,
  });
  expect(
    summarizeReadonlySupervision(f.id, { request: f.request, result: signed(f.result) }, start + 700_000),
  ).toMatchObject({ state: 'failed', forced: true, childCleanupConfirmed: false, samples: null });
});

it.each([
  'request-future',
  'result-future',
  'result-backward',
  'clock-code',
  'completion-before-start',
  'completion-after-cutoff',
])('%s 시각은 clockUnverified이며 기한 경과를 확정하지 않는다', (kind) => {
  const f = fixture();
  let now = start + 700_000;
  if (kind === 'request-future') now = start - 2000;
  if (kind === 'result-future') now = start + 500_000;
  if (kind === 'result-backward') f.result.finishedAt = new Date(start - 3000).toISOString();
  if (kind === 'completion-before-start') f.result.finishedAt = new Date(start - 500).toISOString();
  if (kind === 'completion-after-cutoff') f.result.finishedAt = new Date(start + 850_000).toISOString();
  if (kind === 'clock-code')
    Object.assign(f.result, { state: 'failed', code: 'SUPERVISOR_CLOCK_CHANGED', evidence: null });
  expect(summarizeReadonlySupervision(f.id, { request: f.request, result: signed(f.result) }, now)).toMatchObject({
    clockUnverified: true,
    deadlineElapsed: null,
  });
});

it('동일 helper의 조회 시계가 역행하거나 유한하지 않으면 검증 불가다', async () => {
  const f = await setup();
  let now = start + 1000_000;
  const reader = createReadonlySupervisionStatus(f.root, () => now);
  expect((await reader.list()).clockUnverified).toBe(false);
  now--;
  expect(await reader.list()).toMatchObject({
    clockUnverified: true,
    runs: [expect.objectContaining({ deadlineElapsed: null })],
  });
  now = NaN;
  expect((await reader.list()).clockUnverified).toBe(true);
});

it.each([
  'body-hash',
  'plan-hash',
  'plan-derived',
  'result-build',
  'result-source',
  'result-id',
  'sum',
  'completed-code',
  'forced-clean',
  'unknown-request',
  'unknown-result',
  'plan-inactive-field',
  'demo-instrument',
])('%s 변조를 거부하며 올바른 해시만으로 연결 검사를 우회하지 못한다', (kind) => {
  const f = fixture();
  if (kind === 'plan-hash') f.request.planHash = 'c'.repeat(64);
  if (kind === 'plan-derived') f.request.plan.samples++;
  if (kind === 'result-build') f.result.buildHash = 'c'.repeat(64);
  if (kind === 'result-source') f.result.source = 'market';
  if (kind === 'result-id') f.result.id = randomUUID();
  if (kind === 'sum') f.result.evidence!.closed++;
  if (kind === 'completed-code') f.result.code = 'SUPERVISOR_FAILED';
  if (kind === 'forced-clean') f.result.forced = true;
  if (kind === 'unknown-request') Object.assign(f.request, { token: 'SECRET' });
  if (kind === 'unknown-result') Object.assign(f.result, { pid: 123 });
  if (kind === 'plan-inactive-field') f.request.plan.boundaryAt = new Date(start).toISOString();
  if (kind === 'demo-instrument') f.request.instrument.symbol = 'AAPL';
  // Rehash edited request to ensure semantic validation is independent of mere checksum validity.
  if (['plan-derived', 'plan-inactive-field', 'demo-instrument'].includes(kind)) {
    f.request.planHash = contentHash({
      plan: f.request.plan,
      source: f.request.source,
      instrument: f.request.instrument,
    });
    f.result.planHash = f.request.planHash;
  }
  const result = signed(f.result);
  if (kind === 'body-hash') result.hash = '0'.repeat(64);
  expect(() => summarizeReadonlySupervision(f.id, { request: f.request, result }, start + 700_000)).toThrow();
});

it.each(['root', 'ancestor', 'folder', 'request', 'result'])('%s symlink를 따라가지 않는다', async (kind) => {
  const f = await setup();
  let root = f.root;
  if (kind === 'root' || kind === 'ancestor') {
    root = join(f.root, 'alias');
    await symlink(f.path, root, 'dir');
    if (kind === 'ancestor') root = join(root, 'missing');
  } else if (kind === 'folder') {
    await rm(f.path, { recursive: true });
    await symlink(f.root, f.path, 'dir');
  } else {
    const path = join(f.path, `${kind}.json`);
    if (kind === 'request') await rm(path);
    await symlink(join(f.root, 'SECRET-MISSING'), path);
  }
  const value = await createReadonlySupervisionStatus(root, () => start).list();
  expect(value.runs).toEqual([]);
  if (kind === 'root' || kind === 'ancestor') expect(value.availability).toBe('unavailable');
  else expect(value.rejectedCount).toBe(1);
  expect(JSON.stringify(value)).not.toContain(f.root);
  expect(JSON.stringify(value)).not.toContain('SECRET');
});

it.each(['request', 'result'])('%s 크기 초과·비일반 파일·잘못된 JSON을 거부한다', async (name) => {
  const f = await setup();
  const file = join(f.path, `${name}.json`);
  const reader = createReadonlySupervisionStatus(f.root, () => start);
  for (const text of ['x'.repeat(64 * 1024 + 1), '{"token":"SECRET"', 'null']) {
    await writeFile(file, text);
    expect(await reader.list()).toMatchObject({ runs: [], rejectedCount: 1 });
  }
  await rm(file);
  await mkdir(file);
  expect(await reader.list()).toMatchObject({ runs: [], rejectedCount: 1 });
});

it('파일로 된 루트와 접근 불가를 unavailable로 반환한다', async () => {
  const f = await setup();
  expect(await createReadonlySupervisionStatus(join(f.path, 'request.json')).list()).toMatchObject({
    availability: 'unavailable',
  });
  if (process.getuid?.() === 0) return;
  await chmod(f.root, 0);
  try {
    expect((await createReadonlySupervisionStatus(f.root).list()).availability).toBe('unavailable');
  } finally {
    await chmod(f.root, 0o700);
  }
});

it('UUID가 아닌 이름과 request 없는 result를 제외하고 스캔 상한을 알린다', async () => {
  const f = await setup();
  await rm(join(f.path, 'request.json'));
  await writeFile(join(f.path, 'result.json'), JSON.stringify(signed(f.result)));
  expect(await createReadonlySupervisionStatus(f.root).list()).toMatchObject({ rejectedCount: 1, runs: [] });
  await Promise.all(Array.from({ length: 260 }, (_, i) => mkdir(join(f.root, `invalid-${i}`))));
  const value = await createReadonlySupervisionStatus(f.root).list();
  expect(value.limited).toBe(true);
  expect(value.scannedCount).toBeLessThanOrEqual(256);
  expect(value.rejectedCount).toBeLessThanOrEqual(100);
  expect(value.runs).toEqual([]);
});

it('출력은 허용된 집계만 제공하고 원본 plan·경로·관측 ID·계좌·로그를 제공하지 않는다', async () => {
  const f = await setup();
  await writeFile(join(f.path, 'result.json'), JSON.stringify(signed(f.result)));
  const value = await createReadonlySupervisionStatus(f.root, () => start + 700_000).list();
  expect(value.runs).toHaveLength(1);
  const text = JSON.stringify(value);
  for (const forbidden of [
    f.root,
    f.result.evidence!.id,
    'journalSha256',
    'reservedWindows',
    'observedTtlSeconds',
    'accountId',
    'pid',
    'stdout',
    'stderr',
    'token',
    'SECRET',
  ]) {
    if (forbidden === 'token') continue; // tokenExpiryVerified is a required false boundary flag.
    expect(text).not.toContain(forbidden);
  }
});
