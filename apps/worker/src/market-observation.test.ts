import { afterEach, expect, it, vi } from 'vitest';
import type { PaperEvidence } from '@hth/contracts';
import { BrokerError } from '@hth/broker';
import { assessMarketData, prepareStrategyData } from '@hth/trading';
import { createPaperSyntheticSource } from './paper-synthetic-source.js';
import { assessObservation, runMarketObservation } from './market-observation.js';
import type { ObservationConfig } from './market-observation.js';
import type { PaperSource } from './paper-worker.js';

afterEach(() => vi.useRealTimers());
const instrument = { market: 'KR', symbol: '005930' } as const;
const asOf = '2026-03-25T01:00:01Z';
async function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(asOf));
  const entries = (await createPaperSyntheticSource(21)([instrument], new AbortController().signal)) as PaperEvidence[];
  const source = vi.fn<PaperSource>().mockResolvedValue(entries);
  const config: ObservationConfig = {
    source: 'synthetic-only',
    instruments: [instrument],
    samples: 3,
    intervalMs: 0,
    timeoutMs: 100,
  };
  const record = vi.fn(async () => {});
  const wait = vi.fn(async () => {});
  const createSource = vi.fn(() => source);
  return {
    entries,
    source,
    config,
    record,
    wait,
    createSource,
    run: () => runMarketObservation(config, { createSource, record, wait }, new AbortController().signal),
  };
}
it('시장 데이터 검사와 계좌를 포함한 전략 실행 검사를 분리한다', async () => {
  const { entries } = await fixture();
  const item = entries[0]!;
  const market = {
    ...item.marketData,
    instrument,
    quoteTimestamp: item.quote.timestamp,
    quoteObservedAt: item.quote.observedAt,
    asOf,
  };
  expect(assessMarketData(market).ready).toBe(true);
  expect(prepareStrategyData({ ...market, accountAvailable: false, accountObservedAt: asOf }).blockers).toContain(
    'ACCOUNT_UNAVAILABLE',
  );
  expect(assessObservation(entries, asOf)[0]!.state).toBe('healthy');
});
it('휴장은 지연/시각 누락 사유를 보존하고 미확인 캘린더는 차단한다', async () => {
  const { entries } = await fixture();
  entries[0]!.quote.timestamp = null;
  entries[0]!.marketData.calendar!.today.sessions = [];
  const [closed] = assessObservation(entries, asOf);
  expect(closed!.state).toBe('closed');
  expect(closed!.blockers).toContain('QUOTE_TIME_MISSING');
  expect(closed!.blockers).not.toContain('ACCOUNT_UNAVAILABLE');
  entries[0]!.marketData.calendar!.today.sessionsKnown = false;
  expect(assessObservation(entries, asOf)[0]!.state).toBe('blocked');
});
it('겹치지 않는 유한 관측을 기록하며 source/token 수명은 한 번만 만든다', async () => {
  const context = await fixture();
  let active = 0;
  context.source.mockImplementation(async () => {
    active++;
    expect(active).toBe(1);
    await Promise.resolve();
    active--;
    return context.entries;
  });
  expect(await context.run()).toMatchObject({
    status: 'completed',
    samples: 3,
    healthy: 3,
    errorSamples: 0,
    instruments: { 'KR:005930': { samples: 3, healthy: 3, missingQuoteTimes: 0 } },
  });
  expect(context.createSource).toHaveBeenCalledTimes(1);
  expect(context.record).toHaveBeenCalledTimes(3);
  expect(context.wait).toHaveBeenCalledTimes(2);
});
it('시세 시각이 퇴행하면 회복될 때까지 이전 최댓값과 비교한다', async () => {
  const context = await fixture();
  const old = structuredClone(context.entries);
  old[0]!.quote.timestamp = '2026-03-25T00:59:59Z';
  context.source.mockResolvedValueOnce(context.entries).mockResolvedValue(old);
  expect(await context.run()).toMatchObject({ quoteRegressions: 2, blocked: 2 });
});
it('일시 오류는 관측 간격을 두고 회복하고 원문 오류를 기록하지 않는다', async () => {
  const context = await fixture();
  context.source.mockRejectedValueOnce(new Error('PRIVATE_KEY_AND_ACCOUNT_DO_NOT_STORE'));
  const summary = await context.run();
  expect(summary).toMatchObject({ errorSamples: 1, successfulSamples: 2, status: 'completed' });
  expect(JSON.stringify(context.record.mock.calls)).not.toContain('PRIVATE_KEY');
});
it('연속 세 번의 수집 실패와 인증 오류에는 수집을 중단한다', async () => {
  const context = await fixture();
  context.config.samples = 10;
  context.source.mockRejectedValue(new BrokerError('NETWORK_ERROR'));
  expect(await context.run()).toMatchObject({ status: 'failed', samples: 3 });
  context.source.mockClear().mockRejectedValue(new BrokerError('AUTHENTICATION_FAILED'));
  expect(await context.run()).toMatchObject({ status: 'failed', samples: 1 });
  expect(context.source).toHaveBeenCalledTimes(1);
});
it('시간 초과는 transport를 즉시 취소하고 기록·정리한 다음 반환한다', async () => {
  const context = await fixture();
  const order: string[] = [];
  const task = runMarketObservation(
    context.config,
    {
      createSource: (transportSignal) => async () =>
        new Promise((_, reject) => {
          transportSignal.addEventListener(
            'abort',
            () => {
              order.push('transport stopped');
              reject(new Error('cancelled'));
            },
            { once: true },
          );
        }),
      record: async (record) => {
        expect(record.error).toBe('OBSERVATION_TIMEOUT');
        order.push('recorded');
      },
    },
    new AbortController().signal,
  );
  await vi.advanceTimersByTimeAsync(100);
  expect(await task).toMatchObject({ status: 'failed', samples: 1 });
  expect(order).toEqual(['transport stopped', 'recorded']);
});
it('취소 시 남은 관측을 실행하지 않고 저장 실패를 숨기지 않는다', async () => {
  const context = await fixture();
  const controller = new AbortController();
  const summary = await runMarketObservation(
    context.config,
    {
      createSource: context.createSource,
      record: async () => {
        controller.abort();
      },
    },
    controller.signal,
  );
  expect(summary).toMatchObject({ status: 'cancelled', samples: 1 });
  await expect(
    runMarketObservation(
      context.config,
      {
        createSource: context.createSource,
        record: async () => {
          throw new Error('disk full');
        },
      },
      new AbortController().signal,
    ),
  ).rejects.toThrow('disk full');
});
it('다른 출처·중복/누락 종목·잘못된 응답은 즉시 중단한다', async () => {
  const context = await fixture();
  context.source.mockResolvedValue([context.entries[0], context.entries[0]]);
  expect(await context.run()).toMatchObject({ status: 'failed', errors: { INVALID_RESPONSE: 1 } });
  context.source.mockResolvedValue(context.entries);
  context.config.source = 'toss-readonly';
  expect(await context.run()).toMatchObject({ status: 'failed', samples: 1 });
});
