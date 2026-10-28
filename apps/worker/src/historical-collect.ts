import { historicalRequestSchema } from '@hth/contracts';
import type { HistoricalCalendarObservation, HistoricalObservation, HistoricalRequest } from '@hth/contracts';
import type { ReadonlyBroker } from '@hth/broker';
import { buildHistoricalDataset, historicalDates, marketTradingDate } from '@hth/trading';

export async function collectHistoricalDataset(
  broker: ReadonlyBroker,
  definition: HistoricalRequest,
  options: {
    readonly maxPages?: number;
    readonly now?: () => number;
    readonly signal?: AbortSignal;
  } = {},
) {
  const parsed = historicalRequestSchema.safeParse(definition);
  if (!parsed.success || parsed.data.source !== broker.id) throw new Error('INVALID_HISTORICAL_REQUEST');
  const request = parsed.data;
  const maxPages = options.maxPages ?? 50;
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) throw new Error('INVALID_PAGE_LIMIT');
  const now = options.now ?? Date.now;
  const startedAt = new Date(now()).toISOString();
  if (request.to > marketTradingDate(Date.parse(startedAt), request.instrument.market))
    throw new Error('FUTURE_HISTORICAL_RANGE');
  const abort = () => {
    if (options.signal?.aborted) throw new Error('CANCELLED');
  };
  abort();
  const instruments = await broker.getInstruments([request.instrument]);
  const instrument = instruments[0];
  if (
    instruments.length !== 1 ||
    !instrument ||
    instrument.id.market !== request.instrument.market ||
    instrument.id.symbol !== request.instrument.symbol
  )
    throw new Error('HISTORICAL_INSTRUMENT_MISMATCH');
  const calendars: HistoricalCalendarObservation[] = [];
  for (const date of historicalDates(request)) {
    abort();
    const observedAt = new Date(now()).toISOString();
    const calendar = await broker.getMarketCalendar(request.instrument.market, date);
    if (calendar.today.tradingDate !== date || calendar.today.market !== request.instrument.market)
      throw new Error('CALENDAR_DATE_MISMATCH');
    calendars.push({ day: calendar.today, observedAt });
  }
  const observations: HistoricalObservation[] = [];
  let before = new Date(Date.parse(`${request.to}T00:00:00Z`) + 2 * 86_400_000).toISOString();
  const cursors = new Set<number>();
  let exhausted = false;
  for (let page = 1; page <= maxPages; page += 1) {
    abort();
    const observedAt = new Date(now()).toISOString();
    const result = await broker.getCandles({
      instrument: request.instrument,
      interval: request.interval,
      count: 200,
      adjusted: request.adjusted,
      before,
    });
    if (result.candles.length > 200 || (result.candles.length === 0 && result.nextBefore !== null))
      throw new Error('INVALID_HISTORICAL_PAGE');
    let reachedLowerBound = false;
    for (const candle of result.candles) {
      if (
        candle.instrument.market !== request.instrument.market ||
        candle.instrument.symbol !== request.instrument.symbol ||
        candle.interval !== request.interval ||
        candle.adjusted !== request.adjusted ||
        candle.source !== request.source ||
        Date.parse(candle.timestamp) > Date.parse(before)
      )
        throw new Error('HISTORICAL_CANDLE_MISMATCH');
      if (candle.tradingDate < request.from) reachedLowerBound = true;
      if (candle.tradingDate >= request.from && candle.tradingDate <= request.to)
        observations.push({ candle: { ...candle, isClosed: false }, observedAt, page });
    }
    if (reachedLowerBound || result.nextBefore === null) {
      exhausted = true;
      break;
    }
    const cursor = Date.parse(result.nextBefore);
    if (!Number.isFinite(cursor) || cursor >= Date.parse(before) || cursors.has(cursor))
      throw new Error('CANDLE_CURSOR_NOT_ADVANCING');
    cursors.add(cursor);
    before = result.nextBefore;
  }
  if (!exhausted) throw new Error('BACKFILL_PAGE_LIMIT');
  abort();
  return buildHistoricalDataset({
    request,
    instrument: {
      name: instrument.name,
      currency: instrument.currency,
      nxtSupportedAtCollection: instrument.nxtSupported,
    },
    calendars,
    observations,
    startedAt,
    completedAt: new Date(now()).toISOString(),
  });
}
