import type { BrokerOrder } from '@hth/broker';
export function syntheticOrder(): BrokerOrder {
  return {
    reference: 'synthetic-source-order',
    instrument: { market: 'US', symbol: 'AAPL' },
    side: 'BUY',
    currency: 'USD',
    type: { value: 'LIMIT', known: true },
    validity: { value: 'DAY', known: true },
    status: { value: 'PENDING', known: true },
    requestedQuantity: '5',
    limitPrice: '110',
    requestedAmount: null,
    orderedAt: '2026-11-12T01:00:00.000Z',
    execution: {
      quantity: '0',
      averagePrice: null,
      amount: '0',
      commission: '0',
      tax: '0',
      lastFilledAt: null,
      settlementDate: null,
    },
  };
}
