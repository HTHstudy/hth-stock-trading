import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createObservationJobs } from './observation-jobs.js';
import { createObservationReports } from './observation-reports.js';
import { createAuthenticatedTestApp } from '../test/app.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const startAt = '2026-10-29T13:35:00Z';
async function fixture(terminal?: Record<string, unknown>, name = 'us-2026-10-29') {
  const root = await mkdtemp(join(tmpdir(), 'hth-observation-jobs-'));
  roots.push(root);
  const directory = join(root, name);
  await mkdir(directory);
  const launch = {
    name,
    pid: 12345,
    launchedAt: '2026-10-29T07:00:00Z',
    startAt,
    symbols: 'US:AAPL',
    samples: 60,
    intervalSeconds: 60,
    stateAtLaunch: 'waiting',
    executionEnabled: false,
    scriptSha256: '0'.repeat(64),
  };
  await writeFile(join(directory, 'launch.json'), JSON.stringify(launch));
  const waiting = { service: 'market-observation', state: 'waiting', startsAt: startAt, executionEnabled: false };
  const text = JSON.stringify(waiting) + '\n' + (terminal ? JSON.stringify(terminal) + '\n' : '');
  await writeFile(join(directory, 'process.log'), text);
  return { root, directory, launch, waiting, text };
}
const failure = { service: 'market-observation', code: 'OBSERVATION_START_MISSED', executionEnabled: false };
it('별도 재시도 ID를 허용해 이전 실패 기록을 덮어쓰지 않는다', async () => {
  const context = await fixture(undefined, 'us-2026-10-29-retry-1');
  expect((await createObservationJobs(context.root, () => Date.parse(startAt) - 1).list()).jobs[0]!.id).toBe(
    'us-2026-10-29-retry-1',
  );
});
it('예정 시각 전과 후를 구분하고 생존/실행 여부를 추측하지 않는다', async () => {
  const context = await fixture();
  expect((await createObservationJobs(context.root, () => Date.parse(startAt) - 1).list()).jobs[0]!.state).toBe(
    'scheduled',
  );
  expect((await createObservationJobs(context.root, () => Date.parse(startAt) + 1).list()).jobs[0]).toMatchObject({
    state: 'awaiting-result',
    failureCode: null,
    reportId: null,
    recordedSamples: null,
  });
  expect(await readFile(join(context.directory, 'process.log'), 'utf8')).toBe(context.text);
});
it('놓친 시작을 실패로 표시하고 PID·경로·hash·원본 로그를 반환하지 않는다', async () => {
  const context = await fixture(failure);
  const result = await createObservationJobs(context.root).list();
  expect(result.jobs[0]).toMatchObject({ state: 'failed', failureCode: 'OBSERVATION_START_MISSED', reportId: null });
  expect(JSON.stringify(result)).not.toMatch(/pid|scriptSha256|process\.log|launch\.json|stateAtLaunch|12345/);
});
it('종료 로그의 결과 ID와 횟수는 기록으로만 제공하며 완료 수 불일치를 거부한다', async () => {
  const terminal = {
    service: 'market-observation',
    runId: randomUUID(),
    source: 'toss-readonly',
    state: 'completed',
    samples: 60,
    errorSamples: 0,
    executionEnabled: false,
  };
  const context = await fixture(terminal);
  expect((await createObservationJobs(context.root).list()).jobs[0]).toMatchObject({
    state: 'completed',
    reportId: terminal.runId,
    recordedSamples: 60,
  });
  await writeFile(
    join(context.directory, 'process.log'),
    JSON.stringify(context.waiting) + '\n' + JSON.stringify({ ...terminal, samples: 59 }) + '\n',
  );
  expect(await createObservationJobs(context.root).list()).toMatchObject({ jobs: [], rejectedCount: 1 });
});
it('취소 기록과 잘못된 로그/추가 비공개 필드를 구분한다', async () => {
  const context = await fixture({ service: 'market-observation', state: 'cancelled', executionEnabled: false });
  expect((await createObservationJobs(context.root).list()).jobs[0]!.state).toBe('cancelled');
  for (const text of [
    JSON.stringify(context.waiting) + '\nPRIVATE_KEY',
    JSON.stringify(context.waiting) + '\n' + JSON.stringify({ ...failure, raw: 'PRIVATE' }),
    'x'.repeat(8193),
  ]) {
    await writeFile(join(context.directory, 'process.log'), text);
    const result = await createObservationJobs(context.root).list();
    expect(result.jobs).toEqual([]);
    expect(result.rejectedCount).toBe(1);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  }
  await writeFile(join(context.directory, 'process.log'), context.text);
  await writeFile(join(context.directory, 'launch.json'), JSON.stringify({ ...context.launch, secret: 'PRIVATE' }));
  expect((await createObservationJobs(context.root).list()).rejectedCount).toBe(1);
});
it('폴더·파일 심볼릭 링크와 잘못된 대상/시각을 거부한다', async () => {
  const context = await fixture(failure);
  const linked = join(context.root, 'us-2026-10-30');
  await symlink(context.directory, linked);
  expect((await createObservationJobs(context.root).list()).rejectedCount).toBe(1);
  const outside = join(context.root, 'external.log');
  await writeFile(outside, context.text);
  await rm(join(context.directory, 'process.log'));
  await symlink(outside, join(context.directory, 'process.log'));
  expect((await createObservationJobs(context.root).list()).rejectedCount).toBe(2);
  await rm(join(context.directory, 'process.log'));
  await writeFile(join(context.directory, 'process.log'), context.text);
  for (const change of [{ symbols: 'KR:005930' }, { startAt: '2027-01-01T00:00:00Z' }, { name: 'us-2026-10-30' }]) {
    await writeFile(join(context.directory, 'launch.json'), JSON.stringify({ ...context.launch, ...change }));
    expect((await createObservationJobs(context.root).list()).jobs).toEqual([]);
  }
});
it('없는 루트는 빈 목록이며 루트 심볼릭 링크는 조회 실패다', async () => {
  const context = await fixture();
  expect((await createObservationJobs(join(context.root, 'missing')).list()).jobs).toEqual([]);
  const link = join(context.root, 'root-link');
  await symlink(context.root, link);
  await expect(createObservationJobs(link).list()).rejects.toThrow('OBSERVATION_JOBS_UNAVAILABLE');
});
it('반환·탐색 상한을 초과해 무제한 파일을 읽지 않는다', async () => {
  const context = await fixture();
  for (let day = 1; day <= 25; day++) {
    const name = `us-2026-10-${String(day).padStart(2, '0')}`;
    const dir = join(context.root, name);
    await mkdir(dir);
    await writeFile(join(dir, 'launch.json'), JSON.stringify({ ...context.launch, name }));
    await writeFile(join(dir, 'process.log'), context.text);
  }
  const result = await createObservationJobs(context.root).list();
  expect(result.jobs).toHaveLength(20);
  expect(result.limited).toBe(true);
});
it('API는 기존 인증/localhost 경계와 strict query를 적용한다', async () => {
  const context = await fixture(failure);
  const service = createObservationReports(join(context.root, 'reports'), context.root);
  const app = createAuthenticatedTestApp('silent', undefined, undefined, undefined, undefined, undefined, service);
  const headers = { host: 'localhost:4000', 'x-hth-dashboard': '1' };
  try {
    const response = await app.inject({ method: 'GET', url: '/v1/observations/jobs', headers });
    expect(response.statusCode).toBe(200);
    expect(response.json().jobs[0].state).toBe('failed');
    expect(response.headers['cache-control']).toBe('no-store, private');
    for (const query of ['?path=/tmp', '?accountId=other', '?id=us-2026-10-29'])
      expect((await app.inject({ method: 'GET', url: '/v1/observations/jobs' + query, headers })).statusCode).toBe(400);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/v1/observations/jobs',
          headers: { ...headers, origin: 'https://evil.invalid' },
        })
      ).statusCode,
    ).toBe(403);
  } finally {
    await app.close();
  }
});
