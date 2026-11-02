import { marketTradingDate } from '@hth/trading';
import { contentHash } from '@hth/database';
import type { createDatabase } from '@hth/database';
import type { PaperMarketPlan } from './paper-market-plan.js';
export { verifyPaperMarketPlan } from './paper-market-plan.js';
type Database = ReturnType<typeof createDatabase>;

export function checkPaperPreparation(
  plan: PaperMarketPlan,
  value: Awaited<ReturnType<Database['paperPreparation']['read']>>,
) {
  const account = value.account;
  const strategy = value.strategies.length === 1 ? value.strategies[0] : undefined;
  const revision = value.revisions.length === 1 ? value.revisions[0] : undefined;
  const receipt = value.receipts.length === 1 ? value.receipts[0]!.details : undefined;
  const checks = {
    paperSource: account.mode === 'paper' && account.dataSource === 'toss-readonly',
    stopped: account.stopped,
    noLease: account.leaseToken === null && account.leaseUntil === null,
    initialControl: account.version === 0 && account.epoch === 0 && account.reason === 'PREPARED_OFFLINE',
    limitsMatch: contentHash(account.limits) === contentHash(plan.limits),
    initialCash: contentHash(account.ledger.cash) === contentHash(plan.cash),
    emptyPositions: account.ledger.positions.length === 0,
    unreconciled: account.ledger.reconciled === false,
    initialPnl: account.ledger.dailyPnl.KRW.netPnl === '0' && account.ledger.dailyPnl.USD.netPnl === '0',
    noOrders: value.counts.orders === '0',
    noFills: value.counts.fills === '0',
    noReservations: value.counts.reservations === '0',
    strategyMatches:
      strategy?.strategyId === 'market-ma' &&
      strategy.revision === 1 &&
      strategy.enabled &&
      strategy.version === plan.strategyVersion &&
      contentHash(strategy.definition) === contentHash(plan.strategy) &&
      strategy.definitionHash === contentHash({ version: plan.strategyVersion, definition: plan.strategy }),
    historyMatches:
      revision?.strategyId === 'market-ma' &&
      revision.revision === 1 &&
      revision.enabled &&
      revision.version === plan.strategyVersion &&
      revision.actor === 'system' &&
      contentHash(revision.definition) === contentHash(plan.strategy) &&
      revision.valueHash ===
        contentHash({ revision: 1, version: plan.strategyVersion, enabled: true, definition: plan.strategy }),
    preparationReceipt:
      receipt?.preparation === 'offline-v1' &&
      receipt.source === 'toss-readonly' &&
      receipt.planHash === contentHash(plan),
  };
  return { checks, preparationMatches: Object.values(checks).every((passed) => passed === true) };
}

export function preparationTradingDates(asOf: string) {
  return { KRW: marketTradingDate(Date.parse(asOf), 'KR'), USD: marketTradingDate(Date.parse(asOf), 'US') };
}
