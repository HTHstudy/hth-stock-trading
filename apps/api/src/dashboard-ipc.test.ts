import { EventEmitter } from 'node:events';
import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { loadDashboardFromWorker } from './dashboard-service.js';

vi.mock('node:child_process', () => ({ fork: vi.fn() }));
afterEach(() => vi.clearAllMocks());
it('저장된 목록과 빈 목록을 기본값으로 대체하지 않고 조회 worker에 전달한다', async () => {
  for (const instruments of [[{ market: 'US' as const, symbol: 'MSFT' }], []]) {
    const child = new EventEmitter() as ChildProcess;
    child.kill = vi.fn(() => true);
    vi.mocked(fork).mockReturnValueOnce(child);
    const pending = loadDashboardFromWorker(new AbortController().signal, instruments);
    const options = vi.mocked(fork).mock.calls.at(-1)![2];
    expect(options?.env?.DASHBOARD_WATCHLIST_JSON).toBe(JSON.stringify(instruments));
    child.emit('message', { type: 'error', code: 'WORKER_ERROR' });
    await expect(pending).rejects.toMatchObject({ type: 'error', code: 'WORKER_ERROR' });
  }
});
it('취소된 조회는 child를 생성하지 않는다', async () => {
  await expect(loadDashboardFromWorker(AbortSignal.abort(), [])).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(vi.mocked(fork).mock.calls.length).toBe(0);
});
