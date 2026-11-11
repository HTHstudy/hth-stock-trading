import type { Currency, DecimalString, InstrumentId } from '@hth/contracts';
import type { BrokerAccount } from './index.js';

/** Provider codes remain opaque; known=false never grants a state-machine transition. */
export interface BrokerOrderCode {
  readonly value: string;
  readonly known: boolean;
}
export interface BrokerOrder {
  readonly reference: string;
  readonly instrument: InstrumentId;
  readonly side: 'BUY' | 'SELL';
  readonly type: BrokerOrderCode;
  readonly validity: BrokerOrderCode;
  readonly status: BrokerOrderCode;
  readonly currency: Currency;
  readonly requestedQuantity: DecimalString;
  readonly limitPrice?: DecimalString | null;
  readonly requestedAmount?: DecimalString | null;
  readonly orderedAt: string;
  readonly canceledAt?: string | null;
  /** Cumulative totals, not an incremental fill event or a settlement guarantee. */
  readonly execution: {
    readonly quantity: DecimalString;
    readonly averagePrice: DecimalString | null;
    readonly amount: DecimalString | null;
    readonly commission: DecimalString | null;
    readonly tax: DecimalString | null;
    readonly lastFilledAt: string | null;
    readonly settlementDate: string | null;
  };
}
interface OrderQueryCommon {
  readonly symbol?: string;
  readonly from?: string;
  readonly to?: string;
}
export type BrokerOrderQuery = OrderQueryCommon &
  ({ readonly group: 'OPEN' } | { readonly group: 'CLOSED'; readonly cursor?: string; readonly limit?: number });
export interface BrokerOrderPage {
  readonly requestedGroup: 'OPEN' | 'CLOSED';
  readonly orders: readonly BrokerOrder[];
  readonly nextCursor: string | null;
  readonly hasNext: boolean;
}
/** Optional read-only capability; no submit/modify/cancel or ownership assignment. */
export interface BrokerOrderLookup {
  getOrders(account: BrokerAccount, query: BrokerOrderQuery): Promise<BrokerOrderPage>;
  getOrder(account: BrokerAccount, reference: string): Promise<BrokerOrder>;
}
