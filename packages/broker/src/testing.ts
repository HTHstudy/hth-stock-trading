import { BrokerError } from './errors.js';
import { createTransport } from './toss/transport.js';
import type { TossOptions, TossFetch } from './toss/transport.js';
import { createReadonlyCapabilities } from './toss/readonly.js';
import { createMockOrderWriter } from './toss/order-writer.js';
/** No production origin or global fetch fallback. Inject a fake fetch and keep its responses local. */
export function createTossOrderMockSession(options: Omit<TossOptions, 'fetch'> & { readonly fetch: TossFetch }) {
  if (typeof options.fetch !== 'function' || options.fetch === globalThis.fetch) throw new BrokerError('INVALID_INPUT');
  const transport = createTransport({ ...options }, 'mock-writer');
  return Object.freeze({
    mode: 'mock' as const,
    executionEnabled: false as const,
    readonly: createReadonlyCapabilities(transport),
    writer: createMockOrderWriter(transport),
  });
}
