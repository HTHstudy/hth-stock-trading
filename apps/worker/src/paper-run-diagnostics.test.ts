import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { contentHash } from '@hth/database';
import type { PaperReviewSnapshot } from '@hth/contracts';
import { paperRunDiagnosticsSummarySchema } from '@hth/contracts';
import { paperReviewCheckpoint } from './paper-review.js';
import { summarizeRunDiagnostics } from './paper-run-diagnostics.js';
import { captureRunDiagnostics } from './paper-run-diagnostics-runtime.js';

function fixture() {
  const snapshot: PaperReviewSnapshot = {
    formatVersion: 'paper-review-snapshot-v1',
    source: 'toss-readonly',
    scope: contentHash('account'),
    asOf: '2026-11-03T01:00:00Z',
    version: 10,
    epoch: 4,
    stopped: true,
    leasePresent: false,
    limitsHash: contentHash('limits'),
    strategyHash: contentHash('strategy'),
    cash: { KRW: '1000', USD: '0' },
    dailyPnl: { KRW: { tradingDate: '2026-11-03', netPnl: '0' }, USD: { tradingDate: '2026-11-03', netPnl: '0' } },
    positions: [],
    basis: [],
    intents: [],
    fills: [],
    reservations: [],
    events: [],
  };
  const before = paperReviewCheckpoint(snapshot);
  const eventKey = contentHash(randomUUID());
  const after = paperReviewCheckpoint({
    ...snapshot,
    asOf: '2026-11-03T01:15:00Z',
    version: 20,
    epoch: 7,
    events: [{ key: eventKey, kind: 'STRATEGY_DIAGNOSED', createdAt: '2026-11-03T01:10:00Z' }],
  });
  const batch = {
    formatVersion: 'paper-diagnostics-v1',
    recordedAt: '2026-11-03T01:10:00Z',
    source: 'toss-readonly',
    epoch: 5,
    accountVersion: 15,
    reports: [
      {
        strategyId: 'PRIVATE_STRATEGY',
        strategyVersion: '1',
        strategyRevision: 1,
        instrument: { market: 'KR', symbol: '005930' },
        evaluatedAt: '2026-11-03T01:09:59Z',
        stage: 'strategy',
        action: 'HOLD',
        codes: ['NO_CROSS'],
        closedCandles: 74,
        barAt: null,
        orderState: null,
      },
    ],
  };
  const body = {
    formatVersion: 'paper-run-diagnostics-v1',
    beforeHash: before.hash,
    afterHash: after.hash,
    scope: snapshot.scope,
    capturedAt: '2026-11-03T01:16:00Z',
    events: [{ key: eventKey, batch, batchHash: contentHash(batch) }],
  };
  return { before, after, artifact: { ...body, hash: contentHash(body) } };
}
function rehash(value: ReturnType<typeof fixture>['artifact']) {
  for (const event of value.events) event.batchHash = contentHash(event.batch);
  const { hash, ...body } = value;
  expect(hash).toMatch(/^[a-f0-9]{64}$/);
  return { ...body, hash: contentHash(body) };
}
it('구간에 연결된 진단 전체를 집계하고 식별자·원문·가격을 내보내지 않는다', () => {
  const { before, after, artifact } = fixture();
  const summary = summarizeRunDiagnostics(artifact, before, after);
  expect(summary).toMatchObject({
    availability: 'available',
    recordedBatches: 1,
    recordedReports: 1,
    actions: { BUY: 0, SELL: 0, HOLD: 1, unevaluated: 0 },
    stages: { strategy: 1 },
    reasons: [{ code: 'NO_CROSS', count: 1 }],
  });
  expect(JSON.stringify(summary)).not.toMatch(/PRIVATE_STRATEGY|005930|scope|hash|accountVersion/);
});
it('변조·일부만 내보낸 진단·다른 구간·중복 이벤트·출처를 거부한다', () => {
  const { before, after, artifact } = fixture();
  const changed = [
    { ...artifact, hash: '0'.repeat(64) },
    rehash({ ...artifact, events: [] }),
    rehash({ ...artifact, afterHash: '0'.repeat(64) }),
    rehash({ ...artifact, events: [...artifact.events, ...artifact.events] }),
  ];
  const otherSource = structuredClone(artifact);
  otherSource.events[0]!.batch.source = 'synthetic-only';
  changed.push(rehash(otherSource));
  for (const input of changed) expect(() => summarizeRunDiagnostics(input, before, after)).toThrow();
});
it('구간 밖 시각·마이크로초 역행·미래 version/epoch·허용되지 않은 오류 원문을 거부한다', () => {
  const { before, after, artifact } = fixture();
  for (const modify of [
    (value: typeof artifact) => {
      value.events[0]!.batch.accountVersion = 21;
    },
    (value: typeof artifact) => {
      value.events[0]!.batch.epoch = 8;
    },
    (value: typeof artifact) => {
      value.events[0]!.batch.recordedAt = '2026-11-03T01:15:00.000001Z';
    },
    (value: typeof artifact) => {
      value.events[0]!.batch.reports[0]!.evaluatedAt = '2026-11-03T00:59:59Z';
    },
    (value: typeof artifact) => {
      value.events[0]!.batch.reports[0]!.codes = ['PRIVATE_ERROR'];
    },
  ]) {
    const value = structuredClone(artifact);
    modify(value);
    expect(() => summarizeRunDiagnostics(rehash(value), before, after)).toThrow();
  }
});
it('DB 없는 미리보기와 잘못된 CLI 옵션은 연결·파일 작성을 하지 않는다', async () => {
  const openDatabase = vi.fn();
  const assertDatabase = vi.fn();
  expect(await captureRunDiagnostics([], {}, '/not-accessed', { openDatabase, assertDatabase })).toMatchObject({
    state: 'preview',
    canResume: false,
  });
  for (const args of [['--account=private'], ['--capture', '--run=../env'], ['--output=/tmp/file']])
    await expect(captureRunDiagnostics(args, {}, '/not-accessed', { openDatabase, assertDatabase })).rejects.toThrow();
  expect(openDatabase).not.toHaveBeenCalled();
});
it('사유 중복과 합계가 모순된 공개 집계를 거부한다', () => {
  const { before, after, artifact } = fixture();
  const summary = summarizeRunDiagnostics(artifact, before, after);
  expect(paperRunDiagnosticsSummarySchema.safeParse({ ...summary, recordedReports: 99 }).success).toBe(false);
  expect(
    paperRunDiagnosticsSummarySchema.safeParse({ ...summary, reasons: [...summary.reasons, ...summary.reasons] })
      .success,
  ).toBe(false);
});
