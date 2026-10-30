import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, open, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { observationArtifactSchema } from '@hth/contracts';
import { createObservationReports } from './observation-reports.js';
import { createAuthenticatedTestApp } from '../test/app.js';
import { createApp } from './app.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture(samples = 1) {
  const root = await mkdtemp(join(tmpdir(), 'hth-observation-view-'));
  roots.push(root);
  const id = randomUUID(),
    directory = join(root, id);
  await mkdir(directory);
  const instrument = { market: 'KR' as const, symbol: '005930' };
  const manifest = {
    formatVersion: 'market-observation-v1',
    id,
    startedAt: '2026-03-25T01:00:00Z',
    mode: 'paper',
    assessmentScope: 'market-data-only',
    executionEnabled: false,
    policyVersion: 'market-data-v1',
    source: 'toss-readonly',
    instruments: [instrument],
    samples,
    intervalMs: 10000,
    timeoutMs: 10000,
  };
  const record = {
    index: 1,
    startedAt: '2026-03-25T01:00:00Z',
    finishedAt: '2026-03-25T01:00:01Z',
    durationMs: 12,
    error: null,
    instruments: [
      {
        instrument,
        state: 'healthy',
        blockers: [],
        quoteTimestamp: '2026-03-25T01:00:00Z',
        quoteAgeMs: 1000,
        quoteRegressed: false,
        latestCandleAt: '2026-03-25T00:59:00Z',
        closedCandles: 20,
        pendingCandles: 1,
        blockedCandles: 0,
      },
    ],
  };
  const journal =
    Array.from({ length: samples }, (_, i) => JSON.stringify({ ...record, index: i + 1 })).join('\n') + '\n';
  const artifact = observationArtifactSchema.parse({
    ...manifest,
    finishedAt: '2026-03-25T01:00:02Z',
    journalSha256: createHash('sha256').update(journal).digest('hex'),
    summary: {
      samples,
      successfulSamples: samples,
      errorSamples: 0,
      healthy: samples,
      closed: 0,
      blocked: 0,
      quoteRegressions: 0,
      totalDurationMs: 12 * samples,
      maxDurationMs: 12,
      blockers: {},
      errors: {},
      instruments: {
        'KR:005930': {
          samples,
          healthy: samples,
          closed: 0,
          blocked: 0,
          quoteRegressions: 0,
          missingQuoteTimes: 0,
          maxQuoteAgeMs: 1000,
        },
      },
      status: 'completed',
    },
  });
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(directory, 'samples.jsonl'), journal);
  await writeFile(join(directory, 'summary.json'), JSON.stringify(artifact));
  return { root, id, directory, manifest, record, journal, artifact, service: createObservationReports(root) };
}
it('저장 형식을 검증하고 전체 집계와 최근 50회를 반환한다', async () => {
  const context = await fixture(55);
  expect((await context.service.list()).reports).toHaveLength(1);
  const report = await context.service.get(context.id);
  expect(report).toMatchObject({
    state: 'completed',
    recordedSamples: 55,
    samplesLimited: true,
    summary: { healthy: 55 },
  });
  expect(report.recentSamples).toHaveLength(50);
  expect(report.recentSamples[0]!.index).toBe(6);
  expect(JSON.stringify(report)).not.toMatch(/samples\.jsonl|PRIVATE_KEY|accountNumber/);
});
it('변조된 해시·집계·manifest와 비공개 필드를 거부한다', async () => {
  for (const change of ['hash', 'count', 'manifest', 'private']) {
    const context = await fixture();
    const bad = structuredClone(context.artifact);
    if (change === 'hash') bad.journalSha256 = '0'.repeat(64);
    if (change === 'count') bad.summary.healthy = 99;
    if (change === 'manifest') bad.source = 'synthetic-only';
    await writeFile(
      join(context.directory, 'summary.json'),
      JSON.stringify(change === 'private' ? { ...bad, clientSecret: 'PRIVATE_KEY' } : bad),
    );
    expect(await context.service.list()).toMatchObject({ reports: [], rejectedCount: 1 });
    await expect(context.service.get(context.id)).rejects.toThrow('OBSERVATION_NOT_FOUND');
  }
});
it('미완료와 상위 실행 실패를 정상 종료로 표시하지 않는다', async () => {
  const context = await fixture();
  await rm(join(context.directory, 'summary.json'));
  expect(await context.service.get(context.id)).toMatchObject({
    state: 'incomplete',
    summary: null,
    journalSha256: null,
    recordedSamples: 1,
    monitoring: { evidence: 'provisional' },
  });
  await writeFile(
    join(context.directory, 'failure.json'),
    JSON.stringify({
      ...context.manifest,
      finishedAt: context.artifact.finishedAt,
      journalSha256: context.artifact.journalSha256,
      summary: null,
      failure: { code: 'BROKER_LEASE_BUSY' },
    }),
  );
  expect(await context.service.get(context.id)).toMatchObject({
    state: 'failed',
    summary: null,
    failureCode: 'BROKER_LEASE_BUSY',
    recordedSamples: 1,
  });
});
it('심볼릭 링크·경로 이탈·거대 파일을 거부한다', async () => {
  const context = await fixture();
  await expect(context.service.get('../private')).rejects.toThrow('INVALID_REPORT_ID');
  const linked = randomUUID();
  await symlink(context.directory, join(context.root, linked));
  await expect(context.service.get(linked)).rejects.toThrow('OBSERVATION_NOT_FOUND');
  await rm(join(context.directory, 'samples.jsonl'));
  await symlink(join(context.directory, 'manifest.json'), join(context.directory, 'samples.jsonl'));
  await expect(context.service.get(context.id)).rejects.toThrow('OBSERVATION_NOT_FOUND');
  await rm(join(context.directory, 'samples.jsonl'));
  const file = await open(join(context.directory, 'samples.jsonl'), 'w');
  await file.truncate(33 * 1048576);
  await file.close();
  await expect(context.service.get(context.id)).rejects.toThrow('OBSERVATION_NOT_FOUND');
});
it('해시가 일치해도 journal 형식·연속 순서·종목 혼입을 거부한다', async () => {
  for (const change of ['sequence', 'symbol', 'private']) {
    const context = await fixture();
    const bad = structuredClone(context.record);
    if (change === 'sequence') bad.index = 2;
    if (change === 'symbol') bad.instruments[0]!.instrument.symbol = 'OTHER';
    const journal = JSON.stringify(change === 'private' ? { ...bad, rawAccount: 'PRIVATE_KEY' } : bad) + '\n';
    await writeFile(join(context.directory, 'samples.jsonl'), journal);
    await writeFile(
      join(context.directory, 'summary.json'),
      JSON.stringify({ ...context.artifact, journalSha256: createHash('sha256').update(journal).digest('hex') }),
    );
    await expect(context.service.get(context.id)).rejects.toThrow('OBSERVATION_NOT_FOUND');
  }
});
it('인증·로컬 경계·입력 제한을 적용하고 조회로 수집을 시작하지 않는다', async () => {
  const context = await fixture();
  const app = createAuthenticatedTestApp(
    'silent',
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    context.service,
  );
  const privateApp = createApp(
    'silent',
    undefined,
    undefined,
    undefined,
    undefined,
    {
      read: () => ({ configured: true, authenticated: false, expiresAt: null }),
      login: async () => {
        throw new Error('UNUSED');
      },
      logout: () => '',
      close: () => {},
    },
    context.service,
  );
  const headers = { host: 'localhost:4000' };
  try {
    const before = await readFile(join(context.directory, 'samples.jsonl'), 'utf8');
    expect((await privateApp.inject({ method: 'GET', url: '/v1/observations', headers })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'GET', url: '/v1/observations', headers: { host: 'evil.invalid' } })).statusCode,
    ).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/v1/observations?path=private', headers })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/v1/observations/invalid', headers })).statusCode).toBe(400);
    const response = await app.inject({ method: 'GET', url: `/v1/observations/${context.id}`, headers });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store, private');
    expect(response.body).not.toContain(context.root);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/observations/start',
          headers: { ...headers, 'x-hth-dashboard': '1' },
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
    expect(await readFile(join(context.directory, 'samples.jsonl'), 'utf8')).toBe(before);
  } finally {
    await app.close();
    await privateApp.close();
  }
});
it('대량 목록은 제한을 표시하고 상세 조회는 캐시와 무관하게 재검증한다', async () => {
  const context = await fixture();
  await context.service.list();
  await writeFile(join(context.directory, 'samples.jsonl'), 'tampered\n');
  await expect(context.service.get(context.id)).rejects.toThrow('OBSERVATION_NOT_FOUND');
  expect((await context.service.list()).reports).toHaveLength(0);
  for (let index = 0; index < 52; index++) {
    const id = randomUUID();
    const path = join(context.root, id);
    await mkdir(path);
    await writeFile(join(path, 'manifest.json'), JSON.stringify({ ...context.manifest, id }));
  }
  const result = await createObservationReports(context.root).list();
  expect(result.limited).toBe(true);
  expect(result.reports).toHaveLength(50);
  expect(result.reports.every((item) => item.state === 'incomplete' && item.summary === null)).toBe(true);
});

it('미완료 journal의 전체 줄만 임시 기록으로 읽고 지연과 마지막 성공을 구분한다', async () => {
  const context = await fixture(3);
  await rm(join(context.directory, 'summary.json'));
  const failed = {
    ...context.record,
    index: 2,
    startedAt: '2026-03-25T01:00:11Z',
    finishedAt: '2026-03-25T01:00:12Z',
    error: 'NETWORK_ERROR',
    instruments: [],
  };
  await writeFile(
    join(context.directory, 'samples.jsonl'),
    JSON.stringify(context.record) + '\n' + JSON.stringify(failed) + '\n' + '{"index":3',
  );
  let now = Date.parse('2026-03-25T01:01:05Z');
  const service = createObservationReports(context.root, undefined, () => now);
  const report = await service.get(context.id);
  expect(report).toMatchObject({
    state: 'incomplete',
    recordedSamples: 2,
    summary: null,
    journalSha256: null,
    monitoring: {
      state: 'overdue',
      evidence: 'provisional',
      partialWrite: true,
      lastRecordedAt: failed.finishedAt,
      lastSuccessfulAt: context.record.finishedAt,
      deadlineAt: '2026-03-25T01:01:02.000Z',
    },
  });
  expect(report.recentSamples).toHaveLength(2);
  expect((await service.list()).reports[0]?.monitoring?.state).toBe('overdue');
  now = Date.parse('2026-03-25T01:01:02Z');
  expect((await service.get(context.id)).monitoring?.state).toBe('recent');
  now += 1;
  expect((await service.get(context.id)).monitoring?.state).toBe('overdue');
});

it('정상 품질의 완료 기록도 수집 공백을 보존하고 오래됐다고 실행 중 지연으로 바꾸지 않는다', async () => {
  const context = await fixture(2);
  const later = { ...context.record, index: 2, startedAt: '2026-03-25T01:20:00Z', finishedAt: '2026-03-25T01:20:01Z' };
  const journal = JSON.stringify(context.record) + '\n' + JSON.stringify(later) + '\n';
  await writeFile(join(context.directory, 'samples.jsonl'), journal);
  await writeFile(
    join(context.directory, 'summary.json'),
    JSON.stringify({
      ...context.artifact,
      finishedAt: '2026-03-25T01:20:02Z',
      journalSha256: createHash('sha256').update(journal).digest('hex'),
    }),
  );
  const report = await createObservationReports(context.root, undefined, () => Date.parse('2026-03-26T01:30:00Z')).get(
    context.id,
  );
  expect(report).toMatchObject({
    state: 'completed',
    summary: { healthy: 2 },
    monitoring: {
      state: 'terminal',
      evidence: 'final-hash-verified',
      gapCount: 1,
      maxWaitMs: 1199000,
      maxExcessWaitMs: 1189000,
    },
  });
  expect(report.monitoring?.recentGaps[0]).toMatchObject({ afterIndex: 1, beforeIndex: 2 });
});

it('미완료 기록도 순서·종목·비공개 필드·크기 검증을 우회할 수 없다', async () => {
  for (const change of ['sequence', 'symbol', 'private', 'partial-size']) {
    const context = await fixture(2);
    await rm(join(context.directory, 'summary.json'));
    const bad = structuredClone(context.record);
    if (change === 'sequence') bad.index = 2;
    if (change === 'symbol') bad.instruments[0]!.instrument.symbol = 'OTHER';
    await writeFile(
      join(context.directory, 'samples.jsonl'),
      change === 'partial-size'
        ? 'x'.repeat(8193)
        : JSON.stringify(change === 'private' ? { ...bad, accessToken: 'PRIVATE_KEY' } : bad) + '\n',
    );
    await expect(context.service.get(context.id)).rejects.toThrow('OBSERVATION_NOT_FOUND');
  }
});

it('초기 빈 기록·완료 요약 대기·시각 불확실 상태를 종료나 프로세스 상태로 추정하지 않는다', async () => {
  const context = await fixture();
  await rm(join(context.directory, 'summary.json'));
  const service = createObservationReports(context.root, undefined, () => Date.parse('2026-03-25T01:00:02Z'));
  expect((await service.get(context.id)).monitoring?.state).toBe('awaiting-finalization');
  await writeFile(join(context.directory, 'samples.jsonl'), '');
  expect(await service.get(context.id)).toMatchObject({
    recordedSamples: 0,
    monitoring: { state: 'recent', lastRecordedAt: null },
  });
  const future = createObservationReports(context.root, undefined, () => Date.parse('2026-03-24T01:00:00Z'));
  expect((await future.get(context.id)).monitoring?.state).toBe('clock-unverified');
  await rm(join(context.directory, 'samples.jsonl'));
  expect((await service.get(context.id)).recordedSamples).toBe(0);
});
