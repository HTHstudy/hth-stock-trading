import {
  historicalCalendarSchema,
  historicalDatasetSchema,
  historicalObservationSchema,
  historicalRequestSchema,
} from '@hth/contracts';
import type {
  HistoricalCalendarObservation,
  HistoricalDataset,
  HistoricalObservation,
  HistoricalRequest,
} from '@hth/contracts';
import { assessCandle } from './candles.js';
import { marketDataPolicy, validMarketDay } from './policy.js';

export function historicalDates(request: HistoricalRequest) {
  const parsed = historicalRequestSchema.safeParse(request);
  if (!parsed.success) throw new Error('INVALID_HISTORICAL_REQUEST');
  const result: string[] = [];
  for (
    let current = Date.parse(`${request.from}T00:00:00Z`);
    current <= Date.parse(`${request.to}T00:00:00Z`);
    current += 86_400_000
  )
    result.push(new Date(current).toISOString().slice(0, 10));
  return result;
}

export function buildHistoricalDataset(input: {
  request: HistoricalRequest;
  instrument: HistoricalDataset['instrument'];
  calendars: readonly HistoricalCalendarObservation[];
  observations: readonly HistoricalObservation[];
  startedAt: string;
  completedAt: string;
}): HistoricalDataset {
  const request = historicalRequestSchema.parse(input.request);
  const dates = historicalDates(request);
  const calendars = input.calendars
    .map((entry) => historicalCalendarSchema.parse(entry))
    .sort((left, right) => left.day.tradingDate.localeCompare(right.day.tradingDate));
  if (
    calendars.length !== dates.length ||
    calendars.some(
      (entry, index) =>
        entry.day.tradingDate !== dates[index] ||
        entry.day.market !== request.instrument.market ||
        Date.parse(entry.observedAt) > Date.parse(input.completedAt),
    )
  )
    throw new Error('CALENDAR_RANGE_MISMATCH');
  const observations = input.observations
    .map((entry) => historicalObservationSchema.parse({ ...entry, candle: { ...entry.candle, isClosed: false } }))
    .sort(
      (left, right) => Date.parse(left.candle.timestamp) - Date.parse(right.candle.timestamp) || left.page - right.page,
    );
  const latest = new Map<string, HistoricalObservation>();
  for (const observation of observations) {
    const candle = observation.candle;
    if (
      candle.instrument.market !== request.instrument.market ||
      candle.instrument.symbol !== request.instrument.symbol ||
      candle.interval !== request.interval ||
      candle.adjusted !== request.adjusted ||
      candle.source !== request.source ||
      candle.currency !== input.instrument.currency ||
      candle.tradingDate < request.from ||
      candle.tradingDate > request.to ||
      Date.parse(observation.observedAt) > Date.parse(input.completedAt)
    )
      throw new Error('HISTORICAL_CANDLE_MISMATCH');
    const timestamp = new Date(candle.timestamp).toISOString();
    const previous = latest.get(timestamp);
    if (previous && previous.page === observation.page && JSON.stringify(previous.candle) !== JSON.stringify(candle))
      throw new Error('CONFLICTING_PAGE_CANDLE');
    latest.set(timestamp, observation);
  }
  const results = [...latest.values()].map((observation) =>
    assessCandle(observation.candle, {
      asOf: input.completedAt,
      observedAt: observation.observedAt,
      day: calendars.find((entry) => entry.day.tradingDate === observation.candle.tradingDate)?.day ?? null,
      nxtSupported: false,
    }),
  );
  const selected = results.filter((entry) => entry.status === 'closed').map((entry) => entry.candle);
  const pending = results.filter((entry) => entry.status === 'pending').length;
  const excluded = results.filter((entry) => entry.reason === 'OUTSIDE_REGULAR_SESSION').length;
  const invalid = results.filter(
    (entry) => entry.status === 'blocked' && entry.reason !== 'OUTSIDE_REGULAR_SESSION',
  ).length;
  const days: HistoricalDataset['coverage']['days'] = calendars.map(({ day }) => {
    const regular = day.sessions.find((session) => session.type === 'regular');
    if (!validMarketDay(day))
      return { date: day.tradingDate, expectedBars: 0, observedBars: 0, missingBars: 0, status: 'unknown' };
    if (!regular) return { date: day.tradingDate, expectedBars: 0, observedBars: 0, missingBars: 0, status: 'holiday' };
    const start = Date.parse(regular.startsAt);
    const end = Date.parse(regular.endsAt);
    const expected = request.interval === '1d' ? 1 : Math.max(0, Math.floor(end / 60_000) - Math.ceil(start / 60_000));
    const observed = selected.filter((candle) => candle.tradingDate === day.tradingDate).length;
    const missing = Math.max(0, expected - observed);
    const closing =
      request.interval === '1d'
        ? Math.max(...day.sessions.map((session) => Date.parse(session.endsAt)))
        : day.market === 'KR'
          ? Math.max(end + 30 * 60_000, Date.parse(`${day.tradingDate}T16:00:00+09:00`))
          : end;
    const unsettled =
      Date.parse(input.completedAt) < closing + marketDataPolicy.settlementDelayMs ||
      results.some((result) => result.candle.tradingDate === day.tradingDate && result.status === 'pending');
    return {
      date: day.tradingDate,
      expectedBars: expected,
      observedBars: observed,
      missingBars: missing,
      status: unsettled ? 'unsettled' : missing || observed !== expected ? 'missing' : 'complete',
    };
  });
  return historicalDatasetSchema.parse({
    formatVersion: 'historical-dataset-v1',
    policyVersion: marketDataPolicy.version,
    request,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    pointInTime: false,
    historicalNxtPolicy: 'conservative-non-nxt',
    instrument: input.instrument,
    calendars,
    observations,
    assessments: results.map((entry) => ({
      timestamp: entry.candle.timestamp,
      status: entry.status,
      reason: entry.reason,
      usableAt: entry.usableAt,
    })),
    candles: selected,
    coverage: {
      complete:
        selected.length > 0 &&
        pending === 0 &&
        invalid === 0 &&
        days.every((day) => day.status === 'complete' || day.status === 'holiday'),
      excludedBars: excluded,
      pendingBars: pending,
      invalidBars: invalid,
      days,
    },
    warnings: [
      'RETROSPECTIVE_DATA',
      'CURRENT_INSTRUMENT_METADATA',
      'ADJUSTMENT_HISTORY_LIMITED',
      ...(request.instrument.market === 'US' && request.interval === '1m' ? ['US_GAPS_MAY_BE_NO_TRADES'] : []),
    ],
  });
}
