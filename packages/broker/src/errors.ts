export type BrokerErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_RESPONSE'
  | 'UNSUPPORTED_MARKET'
  | 'AUTHENTICATION_FAILED'
  | 'PERMISSION_DENIED'
  | 'RATE_LIMITED'
  | 'UPSTREAM_REJECTED'
  | 'UPSTREAM_UNAVAILABLE'
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'CANCELLED';

export class BrokerError extends Error {
  constructor(
    readonly code: BrokerErrorCode,
    readonly status: number | null = null,
    readonly requestId: string | null = null,
  ) {
    super(code);
    this.name = 'BrokerError';
  }
}
