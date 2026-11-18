import type { InstrumentId } from '@hth/contracts';
import type { BrokerAccount } from './index.js';
import type { BrokerErrorCode } from './errors.js';
export interface BrokerLimitOrderRequest {
  readonly profile: 'limit-day-integer-v1';
  readonly clientOrderId: string;
  readonly instrument: InstrumentId;
  readonly side: 'BUY' | 'SELL';
  readonly quantity: string;
  readonly limitPrice: string;
}
interface SubmissionSafety {
  readonly mode: 'mock';
  readonly executionEnabled: false;
  readonly ownershipVerified: false;
  readonly canApplyToLedger: false;
  readonly canResend: false;
  readonly replayed: boolean;
  readonly clientOrderId: string;
}
export type BrokerOrderSubmissionResult = SubmissionSafety &
  (
    | { readonly outcome: 'acknowledged'; readonly reference: string; readonly status: 200 }
    | { readonly outcome: 'unknown' | 'not-sent'; readonly code: BrokerErrorCode; readonly status: number | null }
  );
/** Production factory remains disabled. A mock session is not an execution or ownership capability. */
export interface BrokerOrderWriter {
  readonly mode: 'disabled' | 'mock';
  readonly executionEnabled: false;
  submitOrder(account: BrokerAccount, request: BrokerLimitOrderRequest): Promise<BrokerOrderSubmissionResult>;
}
