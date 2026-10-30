import type { ReadonlyBroker } from '@hth/broker';
import { BrokerError } from '@hth/broker';
import { serveSharedDashboard } from './dashboard-sharing.js';
import type { DashboardShareScope } from './dashboard-sharing.js';
import { collectReadonlySnapshot } from './readonly-snapshot.js';
import { createDashboardSnapshot } from './dashboard-model.js';

// A client cancellation discards its current bounded broker operation and
// prevents the next operation. It never aborts the owner's shared transport.
export function scopedReadonlyBroker(broker: ReadonlyBroker, signal: AbortSignal): ReadonlyBroker {
  const read = async <T>(operation: () => Promise<T>) => {
    if (signal.aborted) throw new BrokerError('CANCELLED');
    const result = await operation();
    if (signal.aborted) throw new BrokerError('CANCELLED');
    return result;
  };
  return {
    id: broker.id,
    listAccounts: () => read(() => broker.listAccounts()),
    getHoldings: (account) => read(() => broker.getHoldings(account)),
    getBuyingPower: (account, currency) => read(() => broker.getBuyingPower(account, currency)),
    getInstruments: (requests) => read(() => broker.getInstruments(requests)),
    getQuotes: (requests) => read(() => broker.getQuotes(requests)),
    getCandles: (query) => read(() => broker.getCandles(query)),
    getMarketCalendar: (market, date) => read(() => broker.getMarketCalendar(market, date)),
    getExchangeRate: (base, quote) => read(() => broker.getExchangeRate(base, quote)),
  };
}
export function shareDashboardBroker(
  scope: DashboardShareScope,
  broker: ReadonlyBroker,
  signal: AbortSignal,
  directory?: string,
) {
  return serveSharedDashboard({
    scope,
    signal,
    ...(directory ? { directory } : {}),
    load: async (instruments, clientSignal) => {
      const source = await collectReadonlySnapshot(
        scopedReadonlyBroker(broker, clientSignal),
        instruments,
        scope.interval,
        1,
      );
      return createDashboardSnapshot(source, new Date().toISOString());
    },
  });
}
