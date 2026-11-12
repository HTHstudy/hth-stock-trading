import { orderObservationSchema } from '@hth/contracts';
import type { OrderObservation } from '@hth/contracts';
import type { BrokerOrder } from '@hth/broker';
const states = new Map<string, OrderObservation['state']>([
  ['PENDING', 'pending'],
  ['PARTIAL_FILLED', 'partial'],
  ['FILLED', 'filled'],
  ['PENDING_CANCEL', 'cancel-pending'],
  ['PENDING_REPLACE', 'replace-pending'],
  ['CANCELED', 'canceled'],
  ['REJECTED', 'rejected'],
  ['REPLACED', 'replaced'],
  ['CANCEL_REJECTED', 'change-rejected'],
  ['REPLACE_REJECTED', 'change-rejected'],
]);
const types = new Map<string, OrderObservation['definition']['type']>([
  ['LIMIT', 'limit'],
  ['MARKET', 'market'],
]);
const validities = new Map<string, OrderObservation['definition']['validity']>([
  ['DAY', 'day'],
  ['OPG', 'opening'],
  ['CLS', 'closing'],
]);
/** scope/observedAt come from the trusted caller, never from an external order field. */
export function toOrderObservation(
  order: BrokerOrder,
  context: { scope: string; observedAt: string },
): OrderObservation {
  const parsed = orderObservationSchema.safeParse({
    formatVersion: 'order-observation-v1',
    ...context,
    orderReference: order.reference,
    instrument: order.instrument,
    side: order.side,
    currency: order.currency,
    definition: {
      type: order.type.known ? (types.get(order.type.value) ?? 'unknown') : 'unknown',
      validity: order.validity.known ? (validities.get(order.validity.value) ?? 'unknown') : 'unknown',
      quantity: order.requestedQuantity,
      ...(order.limitPrice === undefined ? {} : { limitPrice: order.limitPrice }),
      ...(order.requestedAmount === undefined ? {} : { amount: order.requestedAmount }),
      orderedAt: order.orderedAt,
    },
    state: order.status.known ? (states.get(order.status.value) ?? 'unknown') : 'unknown',
    ...(order.canceledAt === undefined ? {} : { canceledAt: order.canceledAt }),
    execution: order.execution,
  });
  if (!parsed.success) throw new Error('ORDER_OBSERVATION_INVALID');
  return parsed.data;
}
