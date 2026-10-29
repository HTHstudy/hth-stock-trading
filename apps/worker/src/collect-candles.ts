import type { Candle, InstrumentId } from '@hth/contracts';
import type { ReadonlyBroker } from '@hth/broker';

export async function collectCandles(
  broker: Pick<ReadonlyBroker, 'getCandles'>,
  instrument: InstrumentId,
  interval: Candle['interval'],
  maxPages: number,
  signal?: AbortSignal,
): Promise<Candle[]> {
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 5) throw new Error('INVALID_PAGE_LIMIT');
  const candles = new Map<string, Candle>();
  const cursors = new Set<number>();
  let before: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    signal?.throwIfAborted();
    const result = await broker.getCandles({
      instrument,
      interval,
      count: 200,
      adjusted: false,
      ...(before ? { before } : {}),
    });
    signal?.throwIfAborted();
    for (const candle of result.candles) {
      if (
        candle.instrument.market !== instrument.market ||
        candle.instrument.symbol !== instrument.symbol ||
        candle.interval !== interval ||
        candle.adjusted ||
        candle.currency !== (instrument.market === 'KR' ? 'KRW' : 'USD')
      )
        throw new Error('CANDLE_INSTRUMENT_MISMATCH');
      // Preserve the first (newest request's) version at inclusive page boundaries.
      const timestamp = new Date(candle.timestamp).toISOString();
      if (!candles.has(timestamp)) candles.set(timestamp, { ...candle, timestamp, isClosed: false });
    }
    if (!result.nextBefore || result.candles.length === 0) break;
    const cursor = Date.parse(result.nextBefore);
    if (!Number.isFinite(cursor) || cursors.has(cursor) || (before && cursor >= Date.parse(before)))
      throw new Error('CANDLE_CURSOR_NOT_ADVANCING');
    cursors.add(cursor);
    before = result.nextBefore;
  }
  return [...candles.values()].sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
}
