import { createHash } from 'node:crypto';
import { historicalCandleSchema } from '@hth/contracts';
import type { Candle } from '@hth/contracts';

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('INVALID_CANONICAL_VALUE');
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error('INVALID_CANONICAL_VALUE');
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    throw new Error('INVALID_CANONICAL_VALUE');
  return `{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`;
}

export function contentHash(value: unknown) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function normalizeDecimal(value: string) {
  const [whole = '', fraction = ''] = value.split('.');
  const integer = whole.replace(/^0+(?=\d)/, '');
  const decimals = fraction.replace(/0+$/, '');
  return decimals ? `${integer}.${decimals}` : integer;
}

export function candleRevision(candle: Candle) {
  const parsed = historicalCandleSchema.safeParse(candle);
  if (!parsed.success) throw new Error('INVALID_REVISION_CANDLE');
  const payload = {
    instrument: candle.instrument,
    interval: candle.interval,
    timestamp: new Date(candle.timestamp).toISOString(),
    tradingDate: candle.tradingDate,
    currency: candle.currency,
    adjusted: candle.adjusted,
    source: candle.source,
    open: normalizeDecimal(candle.open),
    high: normalizeDecimal(candle.high),
    low: normalizeDecimal(candle.low),
    close: normalizeDecimal(candle.close),
    volume: normalizeDecimal(candle.volume),
  };
  return { payload, valueHash: contentHash(payload) };
}
