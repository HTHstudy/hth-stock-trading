import { z } from 'zod';
import { movingAverageConfigSchema } from '@hth/contracts';
import { marketDataPolicy } from '@hth/trading';
import { contentHash } from '@hth/database';

const instrument = z.strictObject({ market: z.enum(['KR', 'US']), symbol: z.string().regex(/^[A-Z0-9.-]{1,40}$/) });
const instant = z.iso.datetime({ offset: true });
export function requiredPaperWarmupCandles(parameters: unknown) {
  const value = movingAverageConfigSchema.parse(parameters),
    required = value.slowPeriod + 1;
  if (required > 200) throw new Error('PAPER_WARMUP_CONFIG_INVALID');
  return required;
}

// An estimate from one regular session, not a claim that the broker will supply every minute.
export function planPaperWarmup(input: unknown) {
  const value = z
    .strictObject({
      parameters: movingAverageConfigSchema,
      sessionStartsAt: instant,
      sessionEndsAt: instant,
      requestedStartAt: instant.optional(),
      deadline: instant.optional(),
    })
    .parse(input);
  const requiredCandles = requiredPaperWarmupCandles(value.parameters);
  const start = Date.parse(value.sessionStartsAt),
    end = Date.parse(value.sessionEndsAt);
  if (end <= start || end - start >= 86400000) throw new Error('PAPER_WARMUP_CONFIG_INVALID');
  const minute = 60000,
    firstFullIntervalStartsAt = Math.ceil(start / minute) * minute;
  const eligible = firstFullIntervalStartsAt + requiredCandles * minute + marketDataPolicy.settlementDelayMs;
  const recommended = eligible + 180000;
  const requested = value.requestedStartAt ? Date.parse(value.requestedStartAt) : recommended;
  const deadline = value.deadline ? Date.parse(value.deadline) : requested + 25 * minute;
  const theoreticalClosedCandles = Math.max(
    0,
    Math.floor((Math.min(requested - marketDataPolicy.settlementDelayMs, end) - firstFullIntervalStartsAt) / minute),
  );
  const blockers: Array<'WARMUP_TIME_TOO_EARLY' | 'OUTSIDE_SESSION' | 'DEADLINE_OUTSIDE_SESSION'> = [];
  if (requested < eligible) blockers.push('WARMUP_TIME_TOO_EARLY');
  if (requested < start || requested >= end) blockers.push('OUTSIDE_SESSION');
  if (deadline <= requested || deadline >= end || deadline - requested > 30 * minute)
    blockers.push('DEADLINE_OUTSIDE_SESSION');
  const body = {
    formatVersion: 'paper-warmup-plan-v1' as const,
    parameters: value.parameters,
    requiredCandles,
    policyVersion: marketDataPolicy.version,
    settlementDelayMs: marketDataPolicy.settlementDelayMs,
    schedulingBufferMs: 180000,
    sessionStartsAt: new Date(start).toISOString(),
    sessionEndsAt: new Date(end).toISOString(),
    earliestEligibleAt: new Date(eligible).toISOString(),
    recommendedStartAt: new Date(recommended).toISOString(),
    startsAt: new Date(requested).toISOString(),
    deadline: new Date(deadline).toISOString(),
    theoreticalClosedCandlesAtStart: theoreticalClosedCandles,
    blockers,
    state: blockers.length ? ('blocked' as const) : ('prepared' as const),
    actualCandlesVerified: false as const,
    sessionVerified: false as const,
    scheduled: false as const,
    executionEnabled: false as const,
    canResume: false as const,
  };
  return { ...body, hash: contentHash(body) };
}

export function assessPaperWarmup(strategiesInput: unknown, framesInput: unknown) {
  const strategies = z
    .array(z.strictObject({ instrument, parameters: movingAverageConfigSchema }))
    .min(1)
    .max(5)
    .parse(strategiesInput);
  const frames = z
    .array(z.strictObject({ instrument, dataReady: z.boolean(), closedCandles: z.number().int().min(0).max(1000) }))
    .min(1)
    .max(20)
    .parse(framesInput);
  const key = (item: z.infer<typeof instrument>) => item.market + ':' + item.symbol;
  if (new Set(frames.map((frame) => key(frame.instrument))).size !== frames.length)
    throw new Error('PAPER_WARMUP_CONFIG_INVALID');
  const reports = strategies.map((strategy, index) => {
    const requiredCandles = requiredPaperWarmupCandles(strategy.parameters),
      frame = frames.find((frame) => key(frame.instrument) === key(strategy.instrument));
    const availableCandles = frame?.closedCandles ?? 0,
      dataReady = frame?.dataReady ?? false;
    return {
      strategyIndex: index,
      instrument: strategy.instrument,
      requiredCandles,
      availableCandles,
      missingCandles: Math.max(0, requiredCandles - availableCandles),
      dataReady,
      ready: dataReady && availableCandles >= requiredCandles,
      reason: !dataReady
        ? ('DATA_NOT_READY' as const)
        : availableCandles < requiredCandles
          ? ('INSUFFICIENT_CANDLES' as const)
          : ('SUFFICIENT_CANDLES' as const),
    };
  });
  return {
    ready: reports.every((report) => report.ready),
    reports,
    executionEnabled: false as const,
    canResume: false as const,
  };
}
