import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { createWorkerStatus } from './worker-status.js';
import { createAuthenticatedTestApp } from '../test/app.js';
import { createApp } from './app.js';
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'worker-status-'));
  roots.push(root);
  const runtime = {
    formatVersion: 'worker-runtime-v1',
    bootId: randomUUID(),
    mode: 'paper',
    source: 'synthetic-only',
    state: 'paused',
    startedAt: '2026-10-30T01:00:00Z',
    heartbeatAt: '2026-10-30T01:00:30Z',
    lastProgressAt: '2026-10-30T01:00:10Z',
    intervalSeconds: 10,
    code: null,
    executionEnabled: false,
  };
  await writeFile(join(root, 'worker.json'), JSON.stringify(runtime));
  return { root, runtime };
}
it('heartbeat와 작업 응답을 분리하고 기한/정지/시각 불확실을 구분한다', async () => {
  const c = await fixture();
  let now = Date.parse('2026-10-30T01:01:00Z');
  const service = createWorkerStatus(c.root, () => now);
  expect(await service.get()).toMatchObject({
    availability: 'fresh',
    progress: 'recent',
    runtime: { state: 'paused' },
  });
  now++;
  expect((await service.get()).progress).toBe('overdue');
  now = Date.parse('2026-10-30T01:01:16Z');
  expect((await service.get()).availability).toBe('stale');
  now = Date.parse('2026-10-30T00:59:59Z');
  expect((await service.get()).availability).toBe('clock-unverified');
  await writeFile(
    join(c.root, 'worker.json'),
    JSON.stringify({ ...c.runtime, state: 'failed', code: 'WORKER_OPERATION_FAILED' }),
  );
  now = Date.parse('2026-10-30T01:00:40Z');
  expect((await service.get()).progress).toBe('not-required');
});
it('누락·원문 필드·거대 파일·symlink를 상태 없음으로 다루고 조회는 파일을 변경하지 않는다', async () => {
  const c = await fixture();
  const path = join(c.root, 'worker.json');
  const original = await readFile(path, 'utf8');
  const service = createWorkerStatus(c.root);
  await service.get();
  expect(await readFile(path, 'utf8')).toBe(original);
  for (const content of [JSON.stringify({ ...c.runtime, accessToken: 'PRIVATE_VALUE' }), 'x'.repeat(8193)]) {
    await writeFile(path, content);
    expect(await service.get()).toMatchObject({ availability: 'unavailable', runtime: null });
  }
  await rm(path);
  expect((await service.get()).availability).toBe('unavailable');
  await writeFile(join(c.root, 'target'), original);
  await symlink(join(c.root, 'target'), path);
  expect((await service.get()).availability).toBe('unavailable');
});
it('운영 상태는 소유자/localhost 전용이고 경로·명령 입력을 받지 않는다', async () => {
  const c = await fixture();
  const service = createWorkerStatus(c.root);
  const app = createAuthenticatedTestApp(
    'silent',
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    service,
  );
  const anonymous = createApp(
    'silent',
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    service,
  );
  const headers = { host: 'localhost:4000' };
  try {
    expect((await app.inject({ url: '/v1/worker', headers })).statusCode).toBe(200);
    expect((await app.inject({ url: '/v1/worker?path=../../env', headers })).statusCode).toBe(400);
    expect((await app.inject({ url: '/v1/worker', headers, remoteAddress: '172.17.0.2' })).statusCode).toBe(403);
    expect((await anonymous.inject({ url: '/v1/worker', headers })).statusCode).toBe(503);
  } finally {
    await Promise.all([app.close(), anonymous.close()]);
  }
});
