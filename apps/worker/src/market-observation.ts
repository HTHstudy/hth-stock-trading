import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { BrokerError } from '@hth/broker';
import { dataBlockerSchema, paperEvidenceSchema, paperOrderCandidateSchema } from '@hth/contracts';
import type { InstrumentId, PaperEvidence } from '@hth/contracts';
import { assessMarketData, paperSessionState } from '@hth/trading';
import type { PaperSource } from './paper-worker.js';

const errorSchema = z.enum([
  'INVALID_INPUT',
  'INVALID_RESPONSE',
  'UNSUPPORTED_MARKET',
  'AUTHENTICATION_FAILED',
  'PERMISSION_DENIED',
  'RATE_LIMITED',
  'UPSTREAM_REJECTED',
  'UPSTREAM_UNAVAILABLE',
  'NETWORK_ERROR',
  'TIMEOUT',
  'CANCELLED',
  'OBSERVATION_TIMEOUT',
  'OBSERVATION_FAILED',
]);
export const observationRecordSchema = z
  .object({
    index: z.number().int().positive(),
    startedAt: z.iso.datetime({ offset: true }),
    finishedAt: z.iso.datetime({ offset: true }),
    durationMs: z.number().finite().nonnegative(),
    error: errorSchema.nullable(),
    instruments: z
      .array(
        z
          .object({
            instrument: paperOrderCandidateSchema.shape.instrument,
            state: z.enum(['healthy', 'closed', 'blocked']),
            blockers: z.array(dataBlockerSchema),
            quoteTimestamp: z.iso.datetime({ offset: true }).nullable(),
            quoteAgeMs: z.number().finite().nullable(),
            quoteRegressed: z.boolean(),
            latestCandleAt: z.iso.datetime({ offset: true }).nullable(),
            closedCandles: z.number().int().nonnegative(),
            pendingCandles: z.number().int().nonnegative(),
            blockedCandles: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(5),
  })
  .strict();
export type ObservationRecord = z.infer<typeof observationRecordSchema>;
export interface ObservationConfig {
  source: 'synthetic-only' | 'toss-readonly';
  instruments: readonly InstrumentId[];
  samples: number;
  intervalMs: number;
  timeoutMs: number;
}
const configSchema = z
  .object({
    source: z.enum(['synthetic-only', 'toss-readonly']),
    instruments: z.array(paperOrderCandidateSchema.shape.instrument).min(1).max(5),
    samples: z.number().int().min(1).max(10000),
    intervalMs: z.number().int().min(0).max(3600000),
    timeoutMs: z.number().int().min(1).max(10000),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.instruments.map((item) => `${item.market}:${item.symbol}`)).size === value.instruments.length,
  );
export function observationFailureCode(error: unknown): string {
  if (error instanceof BrokerError && errorSchema.safeParse(error.code).success) return error.code;
  return error instanceof Error &&
    ['BROKER_LEASE_BUSY', 'BROKER_LEASE_LOST', 'MARKET_OBSERVATION_CONFIGURATION_INVALID'].includes(error.message)
    ? error.message
    : 'OBSERVATION_FAILED';
}
const key = (instrument: InstrumentId) => `${instrument.market}:${instrument.symbol}`;
export function assessObservation(
  entries: readonly PaperEvidence[],
  asOf: string,
  previous: ReadonlyMap<string, string> = new Map(),
): ObservationRecord['instruments'] {
  return entries.map((entry) => {
    const data = assessMarketData({
      ...entry.marketData,
      instrument: entry.quote.instrument,
      quoteTimestamp: entry.quote.timestamp,
      quoteObservedAt: entry.quote.observedAt,
      asOf,
    });
    let session: 'open' | 'closed' | 'unknown' = 'unknown';
    try {
      session = paperSessionState([entry], [entry.quote.instrument], asOf);
    } catch {
      /* Unknown calendars remain blocked. */
    }
    const earlier = previous.get(key(entry.quote.instrument));
    const quoteRegressed = Boolean(
      earlier && entry.quote.timestamp && Date.parse(entry.quote.timestamp) < Date.parse(earlier),
    );
    const blockers = [...data.blockers];
    if (
      (quoteRegressed || !entry.sourcesHealthy || entry.hasUnknownOrders || session === 'unknown') &&
      !blockers.includes('INVALID_DATA')
    )
      blockers.push('INVALID_DATA');
    return {
      instrument: entry.quote.instrument,
      state:
        session === 'unknown' || !entry.sourcesHealthy || entry.hasUnknownOrders || quoteRegressed
          ? 'blocked'
          : session === 'closed'
            ? 'closed'
            : blockers.length
              ? 'blocked'
              : 'healthy',
      blockers,
      quoteTimestamp: entry.quote.timestamp,
      quoteAgeMs: entry.quote.timestamp === null ? null : Date.parse(asOf) - Date.parse(entry.quote.timestamp),
      quoteRegressed,
      latestCandleAt: entry.marketData.candles.at(-1)?.timestamp ?? null,
      closedCandles: data.assessments.filter((item) => item.status === 'closed').length,
      pendingCandles: data.assessments.filter((item) => item.status === 'pending').length,
      blockedCandles: data.assessments.filter((item) => item.status === 'blocked').length,
    };
  });
}

export async function runMarketObservation(
  config: ObservationConfig,
  dependencies: {
    createSource: (signal: AbortSignal) => PaperSource;
    record: (record: ObservationRecord) => Promise<void>;
    now?: () => number;
    elapsed?: () => number;
    wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  },
  signal: AbortSignal,
) {
  configSchema.parse(config);
  const now = dependencies.now ?? Date.now;
  const elapsed = dependencies.elapsed ?? (() => performance.now());
  const wait = dependencies.wait ?? ((ms, stop) => delay(ms, undefined, { signal: stop }));
  const lifetime = new AbortController();
  const combined = AbortSignal.any([signal, lifetime.signal]);
  const summary = {
    samples: 0,
    successfulSamples: 0,
    errorSamples: 0,
    healthy: 0,
    closed: 0,
    blocked: 0,
    quoteRegressions: 0,
    totalDurationMs: 0,
    maxDurationMs: 0,
    blockers: {} as Record<string, number>,
    errors: {} as Record<string, number>,
    instruments: {} as Record<
      string,
      {
        samples: number;
        healthy: number;
        closed: number;
        blocked: number;
        quoteRegressions: number;
        missingQuoteTimes: number;
        maxQuoteAgeMs: number | null;
      }
    >,
    status: 'completed' as 'completed' | 'cancelled' | 'failed',
  };
  const previous = new Map<string, string>();
  let pending: Promise<unknown> | undefined;
  let consecutive = 0;
  try {
    if (signal.aborted) {
      summary.status = 'cancelled';
      return summary;
    }
    const source = dependencies.createSource(combined);
    for (let index = 1; index <= config.samples; index++) {
      if (signal.aborted) {
        summary.status = 'cancelled';
        break;
      }
      const startedAt = new Date(now()).toISOString();
      const start = elapsed();
      const read = new AbortController();
      const readSignal = AbortSignal.any([combined, read.signal]);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let error: z.infer<typeof errorSchema> | null = null;
      let metrics: ObservationRecord['instruments'] = [];
      let timedOut = false;
      const abort = () => read.abort();
      combined.addEventListener('abort', abort, { once: true });
      try {
        const failed = new Promise<never>((_, reject) => {
          readSignal.addEventListener('abort', () => reject(new Error('CANCELLED')), { once: true });
          timeout = setTimeout(() => {
            timedOut = true;
            read.abort();
          }, config.timeoutMs);
        });
        pending = source(config.instruments, readSignal);
        const raw = await Promise.race([pending, failed]);
        readSignal.throwIfAborted();
        const entries = z.array(paperEvidenceSchema).max(5).parse(raw);
        const keys = new Set(entries.map((entry) => key(entry.quote.instrument)));
        if (
          keys.size !== entries.length ||
          keys.size !== config.instruments.length ||
          config.instruments.some((instrument) => !keys.has(key(instrument))) ||
          entries.some((entry) =>
            entry.marketData.candles.some((candle) =>
              config.source === 'toss-readonly' ? candle.source !== 'toss' : !candle.source.startsWith('synthetic-'),
            ),
          )
        )
          throw new Error('INVALID_RESPONSE');
        metrics = assessObservation(entries, new Date(now()).toISOString(), previous);
      } catch (reason) {
        error = timedOut
          ? 'OBSERVATION_TIMEOUT'
          : signal.aborted
            ? 'CANCELLED'
            : reason instanceof BrokerError
              ? reason.code
              : reason instanceof z.ZodError ||
                  (reason instanceof Error &&
                    [
                      'INVALID_RESPONSE',
                      'PAPER_SOURCE_INSTRUMENT_MISMATCH',
                      'PAPER_SOURCE_CURRENCY_MISMATCH',
                      'PAPER_SOURCE_CALENDAR_MISMATCH',
                      'CANDLE_INSTRUMENT_MISMATCH',
                      'CANDLE_CURSOR_NOT_ADVANCING',
                    ].includes(reason.message))
                ? 'INVALID_RESPONSE'
                : 'OBSERVATION_FAILED';
      } finally {
        clearTimeout(timeout);
        combined.removeEventListener('abort', abort);
        read.abort();
      }
      if (timedOut || signal.aborted) lifetime.abort();
      const record = observationRecordSchema.parse({
        index,
        startedAt,
        finishedAt: new Date(now()).toISOString(),
        durationMs: Math.max(0, elapsed() - start),
        error,
        instruments: metrics,
      });
      await dependencies.record(record);
      summary.samples++;
      summary.totalDurationMs += record.durationMs;
      summary.maxDurationMs = Math.max(summary.maxDurationMs, record.durationMs);
      if (error) {
        summary.errorSamples++;
        consecutive++;
        summary.errors[error] = (summary.errors[error] ?? 0) + 1;
      } else {
        summary.successfulSamples++;
        consecutive = 0;
        for (const metric of metrics) {
          summary[metric.state]++;
          const counters = (summary.instruments[key(metric.instrument)] ??= {
            samples: 0,
            healthy: 0,
            closed: 0,
            blocked: 0,
            quoteRegressions: 0,
            missingQuoteTimes: 0,
            maxQuoteAgeMs: null,
          });
          counters.samples++;
          counters[metric.state]++;
          if (metric.quoteRegressed) counters.quoteRegressions++;
          if (metric.quoteAgeMs === null) counters.missingQuoteTimes++;
          else counters.maxQuoteAgeMs = Math.max(counters.maxQuoteAgeMs ?? 0, metric.quoteAgeMs);
          if (metric.quoteRegressed) summary.quoteRegressions++;
          for (const blocker of new Set(metric.blockers))
            summary.blockers[blocker] = (summary.blockers[blocker] ?? 0) + 1;
          if (
            metric.quoteTimestamp &&
            (!previous.has(key(metric.instrument)) ||
              Date.parse(metric.quoteTimestamp) > Date.parse(previous.get(key(metric.instrument))!))
          )
            previous.set(key(metric.instrument), metric.quoteTimestamp);
        }
      }
      if (signal.aborted) {
        summary.status = 'cancelled';
        break;
      }
      if (
        timedOut ||
        consecutive >= 3 ||
        error === 'AUTHENTICATION_FAILED' ||
        error === 'PERMISSION_DENIED' ||
        error === 'INVALID_RESPONSE' ||
        error === 'UNSUPPORTED_MARKET'
      ) {
        summary.status = 'failed';
        break;
      }
      if (index < config.samples) {
        try {
          await wait(config.intervalMs, combined);
        } catch (reason) {
          if (!signal.aborted) throw reason;
          summary.status = 'cancelled';
          break;
        }
      }
    }
    return summary;
  } finally {
    lifetime.abort();
    await pending?.catch(() => {});
  }
}
export type ObservationSummary = Awaited<ReturnType<typeof runMarketObservation>>;
