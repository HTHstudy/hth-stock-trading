import { createConnection, createServer } from 'node:net';
import { chmod, lstat, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { DashboardSnapshot } from '@hth/contracts';
import { createHarness } from '../../../packages/broker/test/harness.js';
import { dashboardShareAddress, requestSharedDashboard, serveSharedDashboard } from './dashboard-sharing.js';
import { shareDashboardBroker, scopedReadonlyBroker } from './shared-dashboard-broker.js';
import { collectReadonlySnapshot } from './readonly-snapshot.js';
import { createDashboardSnapshot } from './dashboard-model.js';

const scope = {
  clientId: 'fixture-client',
  clientSecret: 'fixture-secret',
  databaseUrl: 'postgresql://localhost/unused',
  interval: '1m' as const,
};
const instruments = [
  { market: 'KR' as const, symbol: '005930' },
  { market: 'US' as const, symbol: 'AAPL' },
];
const roots: string[] = [];
const owners: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  for (const owner of owners.splice(0)) await owner.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function directory() {
  const root = await mkdtemp('/private/tmp/hth-ds-');
  roots.push(root);
  return root;
}
async function snapshot(): Promise<DashboardSnapshot> {
  return createDashboardSnapshot(
    await collectReadonlySnapshot(createHarness().broker, instruments, '1m', 1),
    new Date().toISOString(),
  );
}
it('공유 서버가 없을 때만 null을 반환하며 scope를 결정적으로 분리한다', async () => {
  const root = await directory();
  expect(await requestSharedDashboard(scope, instruments, new AbortController().signal, root)).toBeNull();
  const address = dashboardShareAddress(scope, root);
  expect(address.path).not.toContain(scope.clientSecret);
  expect(
    dashboardShareAddress(
      {
        interval: scope.interval,
        databaseUrl: scope.databaseUrl,
        clientSecret: scope.clientSecret,
        clientId: scope.clientId,
      },
      root,
    ).path,
  ).toBe(address.path);
  expect(dashboardShareAddress({ ...scope, clientSecret: 'other' }, root).path).not.toBe(address.path);
});
it('관측용 broker와 조회 요청들이 토큰 한 개와 기존 rate limiter를 재사용한다', async () => {
  const root = await directory();
  const { broker, fetcher, advance } = createHarness();
  const control = new AbortController();
  await broker.getQuotes(instruments);
  const owner = await shareDashboardBroker(scope, broker, control.signal, root);
  owners.push(owner);
  const result = await requestSharedDashboard(scope, instruments, new AbortController().signal, root);
  expect(result?.watchlist).toHaveLength(2);
  expect(result?.portfolios).toHaveLength(2);
  await broker.getQuotes(instruments);
  await requestSharedDashboard(scope, [], new AbortController().signal, root);
  expect(fetcher.mock.calls.filter(([url]) => url.endsWith('/oauth2/token'))).toHaveLength(1);
  advance(3600000);
  await Promise.all([
    broker.getQuotes(instruments),
    requestSharedDashboard(scope, instruments, new AbortController().signal, root),
  ]);
  expect(fetcher.mock.calls.filter(([url]) => url.endsWith('/oauth2/token'))).toHaveLength(2);
  expect(JSON.stringify(result)).not.toMatch(
    /fixture-token|fixture-secret|accountNo|accountSeq|reference|client_secret|access_token/,
  );
  expect((await lstat(dashboardShareAddress(scope, root).path)).mode & 0o777).toBe(0o600);
  await owner.close();
  expect(await requestSharedDashboard(scope, instruments, new AbortController().signal, root)).toBeNull();
});
it('동시 추가 조회를 제한하고 클라이언트 취소로 관측 수명을 취소하지 않는다', async () => {
  const root = await directory();
  const value = await snapshot();
  const lifetime = new AbortController();
  let entered!: () => void, ended!: () => void;
  let calls = 0;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const finished = new Promise<void>((resolve) => {
    ended = resolve;
  });
  const owner = await serveSharedDashboard({
    scope,
    directory: root,
    signal: lifetime.signal,
    load: async (_items, signal) => {
      if (++calls > 1) return value;
      entered();
      return new Promise<DashboardSnapshot>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            ended();
            reject(new Error('CANCELLED'));
          },
          { once: true },
        );
      });
    },
  });
  owners.push(owner);
  const client = new AbortController();
  const pending = requestSharedDashboard(scope, instruments, client.signal, root);
  const rejected = expect(pending).rejects.toThrow('CANCELLED');
  await started;
  await expect(requestSharedDashboard(scope, instruments, new AbortController().signal, root)).rejects.toThrow(
    'RATE_LIMITED',
  );
  client.abort();
  await rejected;
  await finished;
  expect(lifetime.signal.aborted).toBe(false);
  expect((await requestSharedDashboard(scope, instruments, new AbortController().signal, root))?.accountCount).toBe(
    value.accountCount,
  );
});
it('조회 취소는 진행 중 응답을 폐기하고 추가 broker 작업만 차단한다', async () => {
  const { broker } = createHarness();
  const control = new AbortController();
  let deliver!: () => void;
  vi.spyOn(broker, 'getQuotes').mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      deliver = resolve;
    });
    return [];
  });
  const facade = scopedReadonlyBroker(broker, control.signal);
  const pending = facade.getQuotes(instruments);
  const rejected = expect(pending).rejects.toThrow('CANCELLED');
  control.abort();
  deliver();
  await rejected;
  const accounts = vi.spyOn(broker, 'listAccounts');
  await expect(facade.listAccounts()).rejects.toThrow('CANCELLED');
  expect(accounts).not.toHaveBeenCalled();
  expect(await broker.getQuotes(instruments)).toHaveLength(2);
});
it('owner 종료는 진행 작업 정리 후 socket을 제거하고 같은 scope로 다시 열 수 있다', async () => {
  const root = await directory();
  const control = new AbortController();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const first = await serveSharedDashboard({
    scope,
    directory: root,
    signal: control.signal,
    load: async (_items, signal) => {
      entered();
      return new Promise<DashboardSnapshot>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('CANCELLED')), { once: true });
      });
    },
  });
  owners.push(first);
  const pending = requestSharedDashboard(scope, instruments, new AbortController().signal, root);
  const rejected = expect(pending).rejects.toThrow();
  await started;
  control.abort();
  await first.close();
  await rejected;
  const second = await serveSharedDashboard({
    scope,
    directory: root,
    signal: new AbortController().signal,
    load: snapshot,
  });
  owners.push(second);
  expect(await requestSharedDashboard(scope, instruments, new AbortController().signal, root)).not.toBeNull();
});
it('임의 명령과 원문 오류를 차단하고 한 번의 동기 오류 뒤에도 연결을 유지한다', async () => {
  const root = await directory();
  let calls = 0;
  const load = vi.fn(() => {
    calls++;
    throw new Error('PRIVATE_SECRET_DO_NOT_SEND');
  });
  const owner = await serveSharedDashboard({ scope, directory: root, signal: new AbortController().signal, load });
  owners.push(owner);
  const raw = await new Promise<string>((resolve, reject) => {
    const socket = createConnection(dashboardShareAddress(scope, root).path);
    let data = '';
    socket.once('connect', () =>
      socket.write(JSON.stringify({ protocol: 'readonly-dashboard-v1', operation: 'token', instruments }) + '\n'),
    );
    socket.on('data', (chunk) => {
      data += chunk;
    });
    socket.once('end', () => resolve(data));
    socket.once('error', reject);
  });
  expect(raw).toContain('INVALID_INPUT');
  expect(load).not.toHaveBeenCalled();
  for (let index = 0; index < 2; index++)
    await expect(requestSharedDashboard(scope, instruments, new AbortController().signal, root)).rejects.toThrow(
      'WORKER_ERROR',
    );
  expect(calls).toBe(2);
});
it('안전하지 않은 디렉터리·기존 파일·심볼릭 링크를 덮어쓰거나 우회하지 않는다', async () => {
  const root = await directory();
  await chmod(root, 0o755);
  await expect(requestSharedDashboard(scope, instruments, new AbortController().signal, root)).rejects.toThrow(
    'DASHBOARD_SHARE_UNAVAILABLE',
  );
  await chmod(root, 0o700);
  const outside = join(root, 'outside');
  await writeFile(outside, 'PRIVATE');
  const path = dashboardShareAddress(scope, root).path;
  await symlink(outside, path);
  await expect(requestSharedDashboard(scope, instruments, new AbortController().signal, root)).rejects.toThrow(
    'DASHBOARD_SHARE_UNAVAILABLE',
  );
  await expect(
    serveSharedDashboard({ scope, directory: root, signal: new AbortController().signal, load: snapshot }),
  ).rejects.toThrow('DASHBOARD_SHARE_UNAVAILABLE');
  expect((await lstat(path)).isSymbolicLink()).toBe(true);
});
it('불명확한 연결 응답은 단독 토큰 발급용 null로 바꾸지 않는다', async () => {
  const root = await directory();
  const path = dashboardShareAddress(scope, root).path;
  const server = createServer((socket) => {
    socket.once('data', () => socket.end('{"protocol":"unknown"}\n'));
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  await chmod(path, 0o600);
  owners.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) });
  await expect(requestSharedDashboard(scope, instruments, new AbortController().signal, root)).rejects.toThrow(
    'INVALID_RESPONSE',
  );
});
