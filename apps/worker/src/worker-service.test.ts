import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { runWorkerService } from './worker-service.js';
import { parseWorkerServiceConfig } from './worker-service-config.js';
async function waitFor(path: string, state: string) {
  for (let i = 0; i < 200; i++) {
    try {
      const value = JSON.parse(await readFile(path, 'utf8'));
      if (value.state === state) return value;
    } catch {
      /* Atomic status may not have been published yet. */
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('STATE_TIMEOUT');
}
it('기본 대기 상태를 원자적으로 기록하고 종료해도 실행을 재개하지 않는다', async () => {
  const root = await mkdtemp(join(tmpdir(), 'worker-service-'));
  const controller = new AbortController();
  const task = runWorkerService(parseWorkerServiceConfig({}), controller.signal, root);
  try {
    const value = await waitFor(join(root, 'worker.json'), 'idle');
    expect(value.executionEnabled).toBe(false);
    expect(value.lastProgressAt).toBeNull();
    expect((await stat(join(root, 'worker.json'))).mode & 511).toBe(0o600);
    controller.abort();
    await task;
    expect(JSON.parse(await readFile(join(root, 'worker.json'), 'utf8')).state).toBe('stopped');
  } finally {
    controller.abort();
    await task;
    await rm(root, { recursive: true, force: true });
  }
});
it('사용된 관측 요청은 프로세스 재시작 뒤에도 다시 실행하지 않는다', async () => {
  const root = await mkdtemp(join(tmpdir(), 'worker-service-'));
  const id = randomUUID();
  await writeFile(join(root, `observation-${id}.json`), 'consumed', { mode: 0o600 });
  try {
    for (let i = 0; i < 2; i++) {
      const controller = new AbortController();
      const task = runWorkerService(
        parseWorkerServiceConfig({ WORKER_MODE: 'observe', WORKER_REQUEST_ID: id }),
        controller.signal,
        root,
      );
      try {
        expect(await waitFor(join(root, 'worker.json'), 'awaiting-request')).toMatchObject({
          code: 'REQUEST_ALREADY_CONSUMED',
          lastProgressAt: null,
        });
      } finally {
        controller.abort();
        await task;
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
