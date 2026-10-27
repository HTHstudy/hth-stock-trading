import type { Candle } from '@hth/shared';
import { describe, expect, it, vi } from 'vitest';
import { validateMarketData } from './market-data.js';
import { withBrokerLease } from './lease.js';
import { EventEmitter } from 'node:events';
import type pg from 'pg';

const candle: Candle = {
  instrument: { market: 'KR', symbol: '005930' },
  interval: '1m',
  timestamp: '2026-03-25T00:31:00Z',
  tradingDate: '2026-03-25',
  open: '72000',
  high: '72100',
  low: '71900',
  close: '72000',
  volume: '10',
  currency: 'KRW',
  adjusted: false,
  source: 'toss',
  isClosed: false,
};
const instrument = { id: candle.instrument, currency: candle.currency, name: '삼성전자' };

describe('시장 데이터 저장 경계', () => {
  it('numeric(30,10) 저장에서 반올림·overflow가 일어날 값을 거부한다', () => {
    expect(() => validateMarketData([{ instrument, candles: [{ ...candle, open: '0.12345678901' }] }])).toThrow(
      'CANDLE_PRECISION_EXCEEDED',
    );
    expect(() =>
      validateMarketData([{ instrument, candles: [{ ...candle, volume: '100000000000000000000' }] }]),
    ).toThrow('CANDLE_PRECISION_EXCEEDED');
    expect(() =>
      validateMarketData([{ instrument, candles: [{ ...candle, open: '72000.00000000000' }] }]),
    ).not.toThrow();
    expect(() => validateMarketData([{ instrument, candles: [{ ...candle, currency: 'USD' }] }])).toThrow(
      'CANDLE_INSTRUMENT_MISMATCH',
    );
  });

  it('동일 broker lease가 이미 있으면 외부 호출을 시작하지 않는다', async () => {
    const client = Object.assign(new EventEmitter(), {
      query: vi.fn(async () => ({ rows: [{ acquired: false }] })),
      release: vi.fn(),
    });
    const pool = { connect: vi.fn(async () => client) } as unknown as pg.Pool;
    const operation = vi.fn();
    await expect(withBrokerLease(pool, 1, operation)).rejects.toThrow('BROKER_LEASE_BUSY');
    expect(operation).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledWith(true);
  });

  it('lease 연결 상실을 작업에 전달하고 연결을 해제한다', async () => {
    const client = Object.assign(new EventEmitter(), {
      query: vi.fn(async () => ({ rows: [{ acquired: true }] })),
      release: vi.fn(),
    });
    const pool = { connect: vi.fn(async () => client) } as unknown as pg.Pool;
    await expect(
      withBrokerLease(pool, 1, async (signal) => {
        client.emit('error', new Error('fixture failure'));
        expect(signal.aborted).toBe(true);
      }),
    ).rejects.toThrow('BROKER_LEASE_LOST');
    expect(client.release).toHaveBeenCalledWith(true);
  });
});
