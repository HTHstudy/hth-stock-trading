import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { contentHash } from '@hth/database';
import { movingAverageCross } from '@hth/trading';
import { createHarness } from '../../../packages/broker/test/harness.js';
import { paperWorkerConfigSchema } from './paper-worker.js';
import { runPaperMarket } from './paper-market-runtime.js';
import type { PaperMarketDependencies } from './paper-market-runtime.js';
import { parsePaperMarketConfig } from './paper-market-config.js';

const definition = {
  kind: 'moving-average-cross',
  instrument: { market: 'KR', symbol: '005930' },
  parameters: { fastPeriod: 5, slowPeriod: 20 },
  quantity: '1',
  maxFillQuantity: '1',
} as const;
function fixture(flags: string[] = []) {
  const config = parsePaperMarketConfig(['--account=paper-market-unit', ...flags], {
    TOSS_CLIENT_ID: 'fixture-client',
    TOSS_CLIENT_SECRET: 'fixture-secret',
    DATABASE_URL: 'postgresql://hth:fixture@localhost:5432/hth_trading',
    PAPER_MARKET_DATABASE_URL: 'postgresql://hth_test:fixture@127.0.0.1:55434/hth_readonly_test',
  });
  const stored = {
    id: 'market-ma',
    version: movingAverageCross.version,
    enabled: true,
    revision: 1,
    definition,
    definitionHash: contentHash({ version: movingAverageCross.version, definition }),
  };
  const broker = createHarness().broker;
  const run = vi.fn<ReturnType<PaperMarketDependencies['createWorker']>['run']>().mockResolvedValue();
  let locked = false;
  const dependencies = {
    paper: {
      stop: vi.fn<PaperMarketDependencies['paper']['stop']>().mockResolvedValue(1),
      createAccount: vi
        .fn<PaperMarketDependencies['paper']['createAccount']>()
        .mockResolvedValue({ created: true, executionEnabled: false }),
      configureLimits: vi.fn<PaperMarketDependencies['paper']['configureLimits']>().mockResolvedValue(1),
      configureStrategy: vi.fn<PaperMarketDependencies['paper']['configureStrategy']>().mockResolvedValue(2),
      readStrategies: vi.fn<PaperMarketDependencies['paper']['readStrategies']>().mockResolvedValue([stored]),
      readAccount: vi
        .fn<PaperMarketDependencies['paper']['readAccount']>()
        .mockResolvedValue({ snapshot: { positions: [] } }),
    },
    prepare: vi.fn<PaperMarketDependencies['prepare']>().mockResolvedValue(),
    withBrokerLease: vi.fn<PaperMarketDependencies['withBrokerLease']>().mockImplementation(async (_key, operation) => {
      locked = true;
      try {
        return await operation(new AbortController().signal);
      } finally {
        locked = false;
      }
    }),
    createBroker: vi.fn<PaperMarketDependencies['createBroker']>().mockImplementation(() => {
      expect(locked).toBe(true);
      return broker;
    }),
    createWorker: vi.fn<PaperMarketDependencies['createWorker']>().mockReturnValue({ run }),
  } satisfies PaperMarketDependencies;
  const execute = () => runPaperMarket(config, dependencies, new AbortController().signal, () => {});
  return { config, dependencies, execute, run, stored };
}
it('기존 client hash 잠금을 얻은 뒤 생성하고 기본 정지/예산을 worker에 전달한다', async () => {
  const { execute, dependencies, config } = fixture();
  await execute();
  expect(dependencies.withBrokerLease.mock.calls[0]![0]).toBe(
    createHash('sha256').update(config.clientId!).digest().readInt32BE(0),
  );
  const worker = paperWorkerConfigSchema.parse(dependencies.createWorker.mock.calls[0]![0]);
  expect(worker).toMatchObject({ resume: false, intervalMs: 10000, sourceTimeoutMs: 10000 });
  expect(dependencies.paper.createAccount).not.toHaveBeenCalled();
  expect(dependencies.prepare).not.toHaveBeenCalled();
  expect(dependencies.createBroker.mock.calls[0]![0].signal?.aborted).toBe(true);
});
it('잠금 경합 시 broker/worker/계좌를 건드리지 않는다', async () => {
  const { execute, dependencies } = fixture(['--initialize']);
  dependencies.withBrokerLease.mockRejectedValue(new Error('BROKER_LEASE_BUSY'));
  await expect(execute()).rejects.toThrow('BROKER_LEASE_BUSY');
  expect(dependencies.createBroker).not.toHaveBeenCalled();
  expect(dependencies.paper.createAccount).not.toHaveBeenCalled();
});
it('초기화는 가상 현금만 주고 기존 계좌의 현금/설정을 덮어쓰지 않는다', async () => {
  const { execute, dependencies } = fixture(['--initialize']);
  dependencies.paper.createAccount.mockResolvedValue({ created: false, executionEnabled: false });
  await expect(execute()).rejects.toThrow('PAPER_MARKET_ACCOUNT_EXISTS');
  expect(dependencies.paper.configureLimits).not.toHaveBeenCalled();
  expect(dependencies.paper.configureStrategy).not.toHaveBeenCalled();
  expect(dependencies.createBroker).not.toHaveBeenCalled();
});
it('초기화와 별도의 명시적 resume만 실행에 전달한다', async () => {
  const initialized = fixture(['--initialize', '--prepare']);
  await initialized.execute();
  expect(initialized.dependencies.prepare).toHaveBeenCalledTimes(1);
  expect(initialized.dependencies.paper.createAccount).toHaveBeenCalledWith(
    initialized.config.accountId,
    expect.objectContaining({ positions: [], cash: { KRW: '1000000', USD: '1000' } }),
  );
  const resumed = fixture(['--resume']);
  await resumed.execute();
  expect(paperWorkerConfigSchema.parse(resumed.dependencies.createWorker.mock.calls[0]![0]).resume).toBe(true);
});
it('정지는 broker lock/인증/worker/초기화를 우회한다', async () => {
  const { execute, dependencies, config } = fixture(['--stop']);
  await execute();
  expect(dependencies.paper.stop).toHaveBeenCalledWith(config.accountId, 'PAPER_MARKET_EMERGENCY_STOP');
  expect(dependencies.withBrokerLease).not.toHaveBeenCalled();
  expect(dependencies.createBroker).not.toHaveBeenCalled();
  expect(dependencies.createWorker).not.toHaveBeenCalled();
});
it('정의 hash 위조와 1페이지로 부족한 장기 기간은 인증 전에 차단한다', async () => {
  const { execute, dependencies, stored } = fixture();
  dependencies.paper.readStrategies.mockResolvedValue([{ ...stored, definitionHash: '0'.repeat(64) }]);
  await expect(execute()).rejects.toThrow('PAPER_MARKET_STRATEGIES_INVALID');
  const definition = { ...stored.definition, parameters: { fastPeriod: 5, slowPeriod: 200 } };
  dependencies.paper.readStrategies.mockResolvedValue([
    { ...stored, definition, definitionHash: contentHash({ version: stored.version, definition }) },
  ]);
  await expect(execute()).rejects.toThrow('PAPER_MARKET_STRATEGIES_INVALID');
  expect(dependencies.createBroker).not.toHaveBeenCalled();
});
it('실행 실패 시 broker 취소를 완료하고 오류를 전달한다', async () => {
  const { execute, dependencies, run } = fixture();
  run.mockRejectedValue(new Error('fixture worker failure'));
  await expect(execute()).rejects.toThrow('fixture worker failure');
  expect(dependencies.createBroker.mock.calls[0]![0].signal?.aborted).toBe(true);
});

it('시간 초과된 source의 후속 정리가 끝날 때까지 토큰 잠금을 유지한다', async () => {
  const { execute, dependencies } = fixture();
  const order: string[] = [];
  dependencies.withBrokerLease.mockImplementation(async (_key, operation) => {
    try {
      return await operation(new AbortController().signal);
    } finally {
      order.push('lock released');
    }
  });
  dependencies.createBroker.mockImplementation((options) => {
    const broker = createHarness().broker;
    vi.spyOn(broker, 'getInstruments').mockImplementation(
      () =>
        new Promise((_, reject) => {
          options.signal!.addEventListener(
            'abort',
            () => {
              // Model async transport cleanup after cancellation, rather than simply
              // marking the source aborted before its request has settled.
              setTimeout(() => {
                order.push('read settled');
                reject(new Error('cancelled fixture'));
              }, 5);
            },
            { once: true },
          );
        }),
    );
    return broker;
  });
  dependencies.createWorker.mockImplementation((_value, source) => ({
    run: async () => {
      void source([definition.instrument], new AbortController().signal).catch(() => {});
      throw new Error('fixture timeout');
    },
  }));
  await expect(execute()).rejects.toThrow('fixture timeout');
  expect(order).toEqual(['read settled', 'lock released']);
});
