import { z } from 'zod';
import type { BrokerLimitOrderRequest, BrokerOrderSubmissionResult, BrokerOrderWriter } from '../order-writer.js';
import type { BrokerAccount } from '../index.js';
import { BrokerError } from '../errors.js';
import type { createTransport } from './transport.js';
const requestSchema = z.strictObject({
  profile: z.literal('limit-day-integer-v1'),
  clientOrderId: z.uuid().transform((v) => v.toLowerCase()),
  instrument: z.strictObject({
    market: z.enum(['KR', 'US']),
    symbol: z
      .string()
      .regex(/^[A-Za-z0-9.-]+$/)
      .max(40),
  }),
  side: z.enum(['BUY', 'SELL']),
  quantity: z.string().regex(/^\d+$/).max(20),
  limitPrice: z
    .string()
    .regex(/^\d+(?:\.\d+)?$/)
    .max(30),
});
const accountSchema = z.strictObject({
  reference: z
    .string()
    .regex(/^\d+$/)
    .max(16)
    .transform((v) => v.replace(/^0+(?=\d)/, '')),
  type: z.literal('BROKERAGE'),
});
const acknowledgementDto = z.object({
  result: z.object({
    orderId: z
      .string()
      .min(1)
      .max(512)
      .refine(
        (v) =>
          v !== '.' &&
          v !== '..' &&
          [...v].every((c) => {
            const n = c.codePointAt(0)!;
            return n >= 32 && n !== 127 && !(n >= 0xd800 && n <= 0xdfff);
          }),
      ),
    clientOrderId: z.string().max(36).nullable().optional(),
  }),
});
function decimal(value: string) {
  const [whole = '', fraction = ''] = value.split('.');
  const integer = whole.replace(/^0+(?=\d)/, ''),
    tail = fraction.replace(/0+$/, '');
  return tail ? `${integer}.${tail}` : integer;
}
/** Canonicalize before an intent/attempt hash is committed; this is not a risk or dispatch permit. */
export function normalizeTossLimitOrderRequest(input: unknown): BrokerLimitOrderRequest {
  const p = requestSchema.safeParse(input);
  if (!p.success) throw new BrokerError('INVALID_INPUT');
  const quantity = decimal(p.data.quantity),
    limitPrice = decimal(p.data.limitPrice),
    symbol = p.data.instrument.symbol.toUpperCase();
  const [whole = '', fraction = ''] = limitPrice.split('.');
  if (
    quantity === '0' ||
    !/[1-9]/.test(limitPrice) ||
    (p.data.instrument.market === 'KR'
      ? !/^[A-Z0-9]{6}$/.test(symbol) || fraction.length > 0
      : fraction.length > (whole === '0' ? 4 : 2))
  )
    throw new BrokerError('INVALID_INPUT');
  return Object.freeze({
    ...p.data,
    instrument: Object.freeze({ ...p.data.instrument, symbol }),
    quantity,
    limitPrice,
  });
}
export function createTossOrderWriter(): BrokerOrderWriter {
  return Object.freeze({
    mode: 'disabled' as const,
    executionEnabled: false as const,
    async submitOrder() {
      throw new BrokerError('ORDER_EXECUTION_DISABLED');
    },
  });
}
/** Internal mock-only wire adapter. The transport rejects POST in every production session. */
export function createMockOrderWriter(transport: ReturnType<typeof createTransport>): BrokerOrderWriter {
  const attempts = new Map<string, { fingerprint: string; pending: Promise<BrokerOrderSubmissionResult> }>();
  async function perform(reference: string, request: BrokerLimitOrderRequest): Promise<BrokerOrderSubmissionResult> {
    const safety = {
      mode: 'mock' as const,
      executionEnabled: false as const,
      ownershipVerified: false as const,
      canApplyToLedger: false as const,
      canResend: false as const,
      clientOrderId: request.clientOrderId,
      replayed: false,
    };
    const body = JSON.stringify({
      clientOrderId: request.clientOrderId,
      symbol: request.instrument.symbol,
      side: request.side,
      orderType: 'LIMIT',
      timeInForce: 'DAY',
      quantity: request.quantity,
      price: request.limitPrice,
      confirmHighValueOrder: false,
    });
    const wire = await transport.postOrderOnce(body, reference);
    if (wire.kind !== 'response')
      return Object.freeze({ ...safety, outcome: wire.kind, code: wire.code, status: wire.status });
    if (wire.response.status !== 200) {
      const status = wire.response.status;
      return Object.freeze({
        ...safety,
        outcome: 'unknown',
        code:
          status >= 200 && status < 300
            ? 'INVALID_RESPONSE'
            : status === 401
              ? 'AUTHENTICATION_FAILED'
              : status === 403
                ? 'PERMISSION_DENIED'
                : status === 429
                  ? 'RATE_LIMITED'
                  : status >= 500
                    ? 'UPSTREAM_UNAVAILABLE'
                    : 'UPSTREAM_REJECTED',
        status,
      });
    }
    const parsed = acknowledgementDto.safeParse(wire.payload);
    if (!parsed.success || parsed.data.result.clientOrderId !== request.clientOrderId)
      return Object.freeze({ ...safety, outcome: 'unknown', code: 'INVALID_RESPONSE', status: 200 });
    return Object.freeze({ ...safety, outcome: 'acknowledged', reference: parsed.data.result.orderId, status: 200 });
  }
  return Object.freeze({
    mode: 'mock' as const,
    executionEnabled: false as const,
    async submitOrder(account: BrokerAccount, raw: BrokerLimitOrderRequest) {
      const parsed = accountSchema.safeParse(account);
      if (!parsed.success) throw new BrokerError('INVALID_INPUT');
      const request = normalizeTossLimitOrderRequest(raw),
        fingerprint = JSON.stringify({ account: parsed.data.reference, request });
      const old = attempts.get(request.clientOrderId);
      if (old) {
        if (old.fingerprint !== fingerprint) throw new BrokerError('ORDER_ATTEMPT_CONFLICT');
        return Object.freeze({ ...(await old.pending), replayed: true });
      }
      if (attempts.size >= 256) throw new BrokerError('ORDER_ATTEMPT_LIMIT');
      const pending = perform(parsed.data.reference, request);
      attempts.set(request.clientOrderId, { fingerprint, pending });
      return Object.freeze({ ...(await pending), replayed: false });
    },
  });
}
