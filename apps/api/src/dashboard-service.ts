import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dashboardWorkerMessageSchema } from '@hth/contracts';
import type { DashboardErrorCode, DashboardSnapshot, DashboardState } from '@hth/contracts';

export interface DashboardService {
  read(): DashboardState;
  refresh(): void;
  close(): void;
}

export function createDashboardService(options: {
  enabled: boolean;
  configured: boolean;
  load: (signal: AbortSignal) => Promise<DashboardSnapshot>;
  now?: () => number;
}): DashboardService {
  const now = options.now ?? Date.now;
  let snapshot: DashboardSnapshot | null = null;
  let error: DashboardErrorCode | null = null;
  let controller: AbortController | null = null;
  let nextRefresh = 0;
  let closed = false;
  const service: DashboardService = {
    read() {
      return {
        mode: 'paper',
        executionEnabled: false,
        connection: !options.enabled
          ? 'disabled'
          : !options.configured
            ? 'unconfigured'
            : error
              ? 'error'
              : snapshot
                ? 'connected'
                : 'connecting',
        refreshing: controller !== null,
        canRefresh: !closed && options.enabled && options.configured && controller === null && now() >= nextRefresh,
        error,
        snapshot,
      };
    },
    refresh() {
      if (!service.read().canRefresh) return;
      const active = new AbortController();
      controller = active;
      nextRefresh = now() + 30_000;
      error = null;
      void options
        .load(active.signal)
        .then((result) => {
          if (!closed) snapshot = result;
        })
        .catch((reason: unknown) => {
          if (closed) return;
          const parsed = dashboardWorkerMessageSchema.safeParse(reason);
          error = parsed.success && parsed.data.type === 'error' ? parsed.data.code : 'WORKER_ERROR';
        })
        .finally(() => {
          if (controller === active) controller = null;
        });
    },
    close() {
      closed = true;
      controller?.abort();
    },
  };
  return service;
}

export function loadDashboardFromWorker(signal: AbortSignal): Promise<DashboardSnapshot> {
  return new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(import.meta.resolve('@hth/worker/dashboard-process')), [], {
      execArgv: [],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: process.env,
    });
    let settled = false;
    const finish = (result: DashboardSnapshot | null, code: DashboardErrorCode = 'WORKER_ERROR') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      child.kill('SIGTERM');
      if (result) resolve(result);
      else reject({ type: 'error', code });
    };
    const cancel = () => finish(null, 'CANCELLED');
    const timer = setTimeout(() => finish(null, 'REFRESH_TIMEOUT'), 120_000);
    signal.addEventListener('abort', cancel, { once: true });
    child.on('message', (message: unknown) => {
      const parsed = dashboardWorkerMessageSchema.safeParse(message);
      if (!parsed.success) return finish(null);
      if (parsed.data.type === 'snapshot') finish(parsed.data.snapshot);
      else finish(null, parsed.data.code);
    });
    child.once('error', () => finish(null));
    child.once('exit', () => {
      if (!settled) finish(null);
    });
    if (signal.aborted) cancel();
  });
}
