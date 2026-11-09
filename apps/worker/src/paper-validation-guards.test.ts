import { expect, it, vi } from 'vitest';
import { aggregateObservationRecords } from './observation-evidence.js';
import {
  paperPrerequisiteMaxAgeMs,
  runGuardedPaperValidationPhase,
  verifyPaperPrerequisite,
} from './paper-validation-guards.js';
import type { ObservationRecord } from '@hth/contracts';
import type { PaperWorkerStatus } from './paper-worker.js';

function fixture() {
  const start = Date.parse('2026-11-09T00:00:00Z');
  const at = (ms: number) => new Date(start + ms).toISOString();
  const instrument = { market: 'KR' as const, symbol: '005930' };
  const records: ObservationRecord[] = Array.from({ length: 60 }, (_, index) => ({
    index: index + 1,
    startedAt: at(60_000 + index * 10_000),
    finishedAt: at(60_100 + index * 10_000),
    durationMs: 100,
    error: null,
    instruments: [
      {
        instrument,
        state: 'healthy',
        blockers: [],
        quoteTimestamp: at(60_000 + index * 10_000),
        quoteAgeMs: 100,
        quoteRegressed: false,
        latestCandleAt: at(0),
        closedCandles: 21,
        pendingCandles: 0,
        blockedCandles: 0,
      },
    ],
  }));
  const range = { startedAt: records[0]!.startedAt, finishedAt: records.at(-1)!.finishedAt };
  const report = {
    manifest: {
      formatVersion: 'market-observation-v1',
      id: '12345678-1234-4234-8234-123456789012',
      startedAt: at(60_000),
      mode: 'paper',
      assessmentScope: 'market-data-only',
      executionEnabled: false,
      policyVersion: 'market-data-v1',
      source: 'toss-readonly',
      instruments: [instrument],
      samples: 60,
      intervalMs: 10_000,
      timeoutMs: 10_000,
    },
    state: 'completed',
    finishedAt: at(651_000),
    journalSha256: 'a'.repeat(64),
    summary: aggregateObservationRecords(records, 'completed'),
    failureCode: null,
    recordedSamples: 60,
    recentSamples: records.slice(-50),
    samplesLimited: true,
    monitoring: {
      asOf: at(700_000),
      evidence: 'final-hash-verified',
      state: 'terminal',
      lastRecordedAt: range.finishedAt,
      lastSuccessfulAt: range.finishedAt,
      deadlineAt: null,
      graceMs: 30_000,
      gapCount: 0,
      maxWaitMs: 9900,
      maxExcessWaitMs: 0,
      recentGaps: [],
      partialWrite: false,
    },
  };
  const job = {
    id: 'kr-2026-11-09',
    startsAt: at(60_000),
    launchedAt: at(0),
    instrument,
    requestedSamples: 60,
    intervalSeconds: 10,
    state: 'completed',
    failureCode: null,
    reportId: report.manifest.id,
    recordedSamples: 60,
    executionEnabled: false,
  };
  const context = { instrument, sessionStartsAt: at(0), sessionEndsAt: at(3_600_000), asOf: at(700_000) };
  return { job, evidence: { report, sampleRange: range }, context, at };
}

it('전체 60표본의 범위와 고정 종목·세션·종료 자료를 대조하고 실행 권한은 주지 않는다', () => {
  const f = fixture();
  const result = verifyPaperPrerequisite(f.job, f.evidence, f.context);
  expect(result).toMatchObject({
    sampleRange: f.evidence.sampleRange,
    actualSessionVerified: false,
    executionEnabled: false,
    maximumAgeMs: 15 * 60_000,
  });
  expect(result.evidenceHash).toMatch(/^[a-f0-9]{64}$/);
  expect(result.sampleRange.startedAt).not.toBe(f.evidence.report.recentSamples[0]!.startedAt);
  expect(verifyPaperPrerequisite(f.job, f.evidence, { ...f.context, asOf: f.at(800_000) }).evidenceHash).toBe(
    result.evidenceHash,
  );
});

it('같은 시장의 다른 종목·잘못 연결된 job/report·계획 변경을 거부한다', () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => {
      f.job.instrument = { ...f.job.instrument, symbol: '000660' };
    },
    (f: ReturnType<typeof fixture>) => {
      f.evidence.report.manifest.instruments = [{ ...f.context.instrument, symbol: '000660' }];
    },
    (f: ReturnType<typeof fixture>) => {
      f.job.reportId = '87654321-1234-4234-8234-123456789012';
    },
    (f: ReturnType<typeof fixture>) => {
      f.job.intervalSeconds = 20;
    },
    (f: ReturnType<typeof fixture>) => {
      f.context.instrument = { ...f.context.instrument, symbol: '000660' };
    },
  ]) {
    const f = fixture();
    change(f);
    expect(() => verifyPaperPrerequisite(f.job, f.evidence, f.context)).toThrow('PREREQUISITE_FAILED');
  }
});

it('다른 세션·처음 열 표본이 세션 밖인 자료·종료 역행과 미래 자료를 거부한다', () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => {
      f.context.sessionStartsAt = f.at(86_400_000);
      f.context.sessionEndsAt = f.at(90_000_000);
      f.context.asOf = f.at(87_000_000);
    },
    (f: ReturnType<typeof fixture>) => {
      f.evidence.sampleRange.startedAt = f.at(-1);
    },
    (f: ReturnType<typeof fixture>) => {
      f.evidence.sampleRange.finishedAt = f.at(3_600_000);
    },
    (f: ReturnType<typeof fixture>) => {
      f.evidence.report.finishedAt = f.at(600_000);
    },
    (f: ReturnType<typeof fixture>) => {
      f.context.asOf = f.at(650_000);
    },
    (f: ReturnType<typeof fixture>) => {
      f.context.sessionEndsAt = f.context.sessionStartsAt;
    },
  ]) {
    const f = fixture();
    change(f);
    expect(() => verifyPaperPrerequisite(f.job, f.evidence, f.context)).toThrow('PREREQUISITE_FAILED');
  }
});

it('선행 리포트는 종료 후 15분 경계까지만 허용하고 실행 직전에 다시 확인할 수 있다', () => {
  const f = fixture(),
    finished = Date.parse(f.evidence.report.finishedAt);
  expect(() =>
    verifyPaperPrerequisite(f.job, f.evidence, {
      ...f.context,
      asOf: new Date(finished + paperPrerequisiteMaxAgeMs).toISOString(),
    }),
  ).not.toThrow();
  expect(() =>
    verifyPaperPrerequisite(f.job, f.evidence, {
      ...f.context,
      asOf: new Date(finished + paperPrerequisiteMaxAgeMs + 1).toISOString(),
    }),
  ).toThrow('PREREQUISITE_FAILED');
  const original = verifyPaperPrerequisite(f.job, f.evidence, f.context).evidenceHash;
  f.evidence.report.journalSha256 = 'b'.repeat(64);
  expect(verifyPaperPrerequisite(f.job, f.evidence, f.context).evidenceHash).not.toBe(original);
});

it('최종 검증 없는 자료·공백·불건전 집계·부분 기록·원문 입력은 허용하지 않는다', () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => {
      f.evidence.report.monitoring.gapCount = 1;
    },
    (f: ReturnType<typeof fixture>) => {
      f.evidence.report.monitoring.evidence = 'provisional';
    },
    (f: ReturnType<typeof fixture>) => {
      f.evidence.report.monitoring.state = 'clock-unverified';
    },
    (f: ReturnType<typeof fixture>) => {
      f.evidence.report.monitoring.partialWrite = true;
    },
    (f: ReturnType<typeof fixture>) => {
      f.evidence.report.summary.healthy = 59;
    },
    (f: ReturnType<typeof fixture>) => {
      f.evidence.report.state = 'failed';
    },
  ]) {
    const f = fixture();
    change(f);
    expect(() => verifyPaperPrerequisite(f.job, f.evidence, f.context)).toThrow('PREREQUISITE_FAILED');
  }
  expect(() => verifyPaperPrerequisite({ private: 'secret' }, null, null)).toThrow(/^PREREQUISITE_FAILED$/);
});

const tick = (state: PaperWorkerStatus['state']): PaperWorkerStatus => ({
  state,
  signals: 0,
  fills: 0,
  executionEnabled: false,
});
it.each(['paused', 'waiting'] as const)(
  '재개 구간의 %s는 첫 상태를 보존하고 정리 완료 후 조기 종료한다',
  async (state) => {
    const seen: PaperWorkerStatus[] = [],
      events: string[] = [];
    const code = await runGuardedPaperValidationPhase({
      resume: true,
      onTick: (status) => seen.push(status),
      run: async (onTick) => {
        try {
          onTick(tick('running'));
          onTick(tick(state));
          events.push('unexpected-next-tick');
        } finally {
          await Promise.resolve();
          events.push('cleanup');
        }
      },
    });
    expect(code).toBe(state === 'paused' ? 'PAPER_VALIDATION_PAUSED' : 'PAPER_VALIDATION_WAITING');
    expect(seen.map((s) => s.state)).toEqual(['running', state]);
    expect(events).toEqual(['cleanup']);
  },
);
it('정지 1회 관측의 paused와 재개 구간의 running/HOLD는 조기 종료하지 않는다', async () => {
  for (const [resume, state] of [
    [false, 'paused'],
    [true, 'running'],
  ] as const) {
    const onTick = vi.fn();
    expect(
      await runGuardedPaperValidationPhase({
        resume,
        onTick,
        run: async (emit) => {
          emit(tick(state));
          emit(tick(state));
        },
      }),
    ).toBeNull();
    expect(onTick).toHaveBeenCalledTimes(2);
  }
});
it('정리 실패·취소·외부 오류는 조기 종료 성공으로 바꾸지 않고 원래 오류를 전달한다', async () => {
  for (const failure of [new Error('cleanup failed'), new Error('cancelled'), new Error('PAPER_VALIDATION_PAUSED')]) {
    const cleanup = vi.fn().mockRejectedValue(failure);
    await expect(
      runGuardedPaperValidationPhase({
        resume: true,
        onTick: () => {},
        run: async (emit) => {
          try {
            emit(tick('paused'));
          } finally {
            await cleanup();
          }
        },
      }),
    ).rejects.toBe(failure);
  }
});
it('주입 runtime이 callback 오류를 삼켜도 조기 종료 사실은 사라지지 않는다', async () => {
  expect(
    await runGuardedPaperValidationPhase({
      resume: true,
      onTick: () => {},
      run: async (emit) => {
        try {
          emit(tick('waiting'));
        } catch {
          /* injected broken runtime */
        }
      },
    }),
  ).toBe('PAPER_VALIDATION_WAITING');
});

it('정리 중 도착한 취소·기한 신호를 예상 조기 종료로 숨기지 않는다', async () => {
  for (const reason of [
    new Error('cancelled during cleanup'),
    new Error('BROKER_LEASE_LOST'),
    new DOMException('deadline', 'TimeoutError'),
  ]) {
    const control = new AbortController();
    await expect(
      runGuardedPaperValidationPhase({
        resume: true,
        signal: control.signal,
        onTick: () => {},
        run: async (emit) => {
          try {
            emit(tick('paused'));
          } finally {
            await Promise.resolve();
            control.abort(reason);
          }
        },
      }),
    ).rejects.toBe(reason);
  }
  const control = new AbortController();
  control.abort();
  const run = vi.fn();
  await expect(
    runGuardedPaperValidationPhase({ resume: true, signal: control.signal, onTick: () => {}, run }),
  ).rejects.toThrow();
  expect(run).not.toHaveBeenCalled();
});
