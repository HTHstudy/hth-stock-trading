import { z } from 'zod';
import { currencySchema, decimalSchema, instantSchema } from '@hth/contracts';
import type { BrokerOrder, BrokerOrderLookup } from '../orders.js';
import { BrokerError } from '../errors.js';
import type { createTransport } from './transport.js';

const text = z
  .string()
  .min(1)
  .refine((value) =>
    [...value].every((c) => {
      const point = c.codePointAt(0)!;
      return point >= 32 && point !== 127 && !(point >= 0xd800 && point <= 0xdfff);
    }),
  );
const referenceSchema = text.max(512).refine((s) => s !== '.' && s !== '..');
const symbol = z
  .string()
  .regex(/^[A-Za-z0-9.-]+$/)
  .max(40);
const decimal = decimalSchema.max(30).refine((s) => !s.startsWith('-'));
const code = text.max(64);
const accountSchema = z.object({ reference: z.string().regex(/^\d+$/).max(16) });
const common = { symbol: symbol.optional(), from: z.iso.date().optional(), to: z.iso.date().optional() };
const querySchema = z
  .discriminatedUnion('group', [
    z.strictObject({ ...common, group: z.literal('OPEN') }),
    z.strictObject({
      ...common,
      group: z.literal('CLOSED'),
      cursor: text.max(4096).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
  ])
  .refine((q) => !q.from || !q.to || q.from <= q.to);
// Projection of the official Order / OrderExecution schema, not the internal domain model.
const orderDto = z.object({
  orderId: referenceSchema,
  symbol,
  side: z.enum(['BUY', 'SELL']),
  orderType: code,
  timeInForce: code,
  status: code,
  price: decimal.nullable().optional(),
  quantity: decimal,
  orderAmount: decimal.nullable().optional(),
  currency: currencySchema,
  orderedAt: instantSchema,
  canceledAt: instantSchema.nullable().optional(),
  execution: z.object({
    filledQuantity: decimal,
    averageFilledPrice: decimal.nullable(),
    filledAmount: decimal.nullable(),
    commission: decimal.nullable(),
    tax: decimal.nullable(),
    filledAt: instantSchema.nullable(),
    settlementDate: z.iso.date().nullable(),
  }),
});
const detailDto = z.object({ result: orderDto });
const pageDto = z.object({
  result: z.object({
    orders: z.array(orderDto).max(10000),
    nextCursor: text.max(4096).nullable(),
    hasNext: z.boolean(),
  }),
});
const knownStatuses = new Set([
  'PENDING',
  'PENDING_CANCEL',
  'PENDING_REPLACE',
  'PARTIAL_FILLED',
  'FILLED',
  'CANCELED',
  'REJECTED',
  'CANCEL_REJECTED',
  'REPLACE_REJECTED',
  'REPLACED',
]);
const checked = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BrokerError('INVALID_INPUT');
  return parsed.data;
};
function normalize(row: z.infer<typeof orderDto>): BrokerOrder {
  const e = row.execution;
  return {
    reference: row.orderId,
    instrument: { market: row.currency === 'KRW' ? 'KR' : 'US', symbol: row.symbol.toUpperCase() },
    side: row.side,
    type: { value: row.orderType, known: ['LIMIT', 'MARKET'].includes(row.orderType) },
    validity: { value: row.timeInForce, known: ['DAY', 'CLS', 'OPG'].includes(row.timeInForce) },
    status: { value: row.status, known: knownStatuses.has(row.status) },
    currency: row.currency,
    requestedQuantity: row.quantity,
    ...(row.price === undefined ? {} : { limitPrice: row.price }),
    ...(row.orderAmount === undefined ? {} : { requestedAmount: row.orderAmount }),
    orderedAt: new Date(row.orderedAt).toISOString(),
    ...(row.canceledAt === undefined
      ? {}
      : { canceledAt: row.canceledAt === null ? null : new Date(row.canceledAt).toISOString() }),
    execution: {
      quantity: e.filledQuantity,
      averagePrice: e.averageFilledPrice,
      amount: e.filledAmount,
      commission: e.commission,
      tax: e.tax,
      lastFilledAt: e.filledAt === null ? null : new Date(e.filledAt).toISOString(),
      settlementDate: e.settlementDate,
    },
  };
}
export function createOrderLookup(transport: ReturnType<typeof createTransport>): BrokerOrderLookup {
  return {
    async getOrders(account, query) {
      const { reference } = checked(accountSchema, account);
      const q = checked(querySchema, query);
      const params = new URLSearchParams({ status: q.group });
      if (q.symbol) params.set('symbol', q.symbol.toUpperCase());
      if (q.from) params.set('from', q.from);
      if (q.to) params.set('to', q.to);
      if (q.group === 'CLOSED') {
        if (q.cursor) params.set('cursor', q.cursor);
        if (q.limit !== undefined) params.set('limit', String(q.limit));
      }
      const { result } = await transport.get('/api/v1/orders', 'ORDER_HISTORY', pageDto, params, reference);
      if (
        result.hasNext !== (result.nextCursor !== null) ||
        (q.group === 'OPEN' && result.hasNext) ||
        (q.group === 'CLOSED' && result.orders.length > (q.limit ?? 20)) ||
        new Set(result.orders.map((o) => o.orderId)).size !== result.orders.length
      )
        throw new BrokerError('INVALID_RESPONSE');
      for (const row of result.orders) {
        // The documented creation-date filter uses KST, including US orders.
        const date = new Date(Date.parse(row.orderedAt) + 9 * 3600000).toISOString().slice(0, 10);
        if (
          (q.symbol && row.symbol.toUpperCase() !== q.symbol.toUpperCase()) ||
          (q.from && date < q.from) ||
          (q.to && date > q.to)
        )
          throw new BrokerError('INVALID_RESPONSE');
      }
      return {
        requestedGroup: q.group,
        orders: result.orders.map(normalize),
        nextCursor: result.nextCursor,
        hasNext: result.hasNext,
      };
    },
    async getOrder(account, reference) {
      const { reference: accountReference } = checked(accountSchema, account);
      const id = checked(referenceSchema, reference);
      const { result } = await transport.get(
        `/api/v1/orders/${encodeURIComponent(id)}`,
        'ORDER_HISTORY',
        detailDto,
        new URLSearchParams(),
        accountReference,
      );
      if (result.orderId !== id) throw new BrokerError('INVALID_RESPONSE');
      return normalize(result);
    },
  };
}
