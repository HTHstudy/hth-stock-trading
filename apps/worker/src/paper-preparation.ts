import { parseArgs } from 'node:util';
import { z } from 'zod';
import { paperModeSchema } from '@hth/contracts';
import { contentHash, createDatabase } from '@hth/database';
import {
  assertDedicatedPaperDatabase,
  dedicatedPaperDatabaseUrl,
  localComposeEnvironment,
  migrateDedicatedPaperDatabase,
} from '@hth/database/testing';
import { readPaperMarketPlan, verifyPaperMarketPlan } from './paper-market-plan.js';
import type { PaperMarketPlan } from './paper-market-plan.js';

type Database = ReturnType<typeof createDatabase>;
export function parsePaperPreparation(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      plan: { type: 'string' },
      'plan-hash': { type: 'string' },
      account: { type: 'string' },
      apply: { type: 'boolean', default: false },
      check: { type: 'boolean', default: false },
      migrate: { type: 'boolean', default: false },
    },
  });
  const path = z.string().min(1).parse(values.plan);
  if ((values.apply && values.check) || (values.migrate && !values.apply))
    throw new Error('PAPER_PREPARATION_FLAGS_INVALID');
  const usesDatabase = values.apply || values.check;
  if (!usesDatabase && (values.account !== undefined || values['plan-hash'] !== undefined))
    throw new Error('PAPER_PREPARATION_FLAGS_INVALID');
  return {
    path,
    apply: values.apply,
    check: values.check,
    migrate: values.migrate,
    accountId: usesDatabase
      ? z
          .string()
          .regex(/^paper-market-[A-Za-z0-9._:-]{1,70}$/)
          .parse(values.account)
      : null,
    planHash: usesDatabase
      ? z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .parse(values['plan-hash'])
      : null,
  };
}

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

export async function runPaperPreparation(
  args: string[],
  environment: Record<string, string | undefined>,
  dependencies = {
    openDatabase: createDatabase,
    assertDatabase: assertDedicatedPaperDatabase,
    migrate: migrateDedicatedPaperDatabase,
  },
) {
  paperModeSchema.parse(environment.TRADING_MODE);
  const config = parsePaperPreparation(args);
  const input = await readPaperMarketPlan(config.path);
  // Hash verification precedes even opening the connection or applying migrations.
  const plan = config.planHash ? verifyPaperMarketPlan(input, config.planHash) : input;
  const base = {
    service: 'paper-preparation',
    mode: 'paper',
    source: 'toss-readonly',
    executionEnabled: false,
    canResume: false,
    marketReadiness: 'not-checked',
    planHash: contentHash(plan),
    market: plan.strategy.instrument.market,
    pendingChecks: [
      'market-observation-review',
      'paused-market-observation',
      'daily-loss-review',
      'separate-paper-resume',
    ],
  } as const;
  if (!config.accountId) return { ...base, state: 'preview', plan };
  const local = environment.LOCAL_CONTAINER_MODE === 'true' && environment.NODE_ENV === 'production';
  const hydrated = { ...environment, ...localComposeEnvironment(environment) };
  const url = dedicatedPaperDatabaseUrl(hydrated.PAPER_MARKET_DATABASE_URL, local);
  const database = dependencies.openDatabase(url);
  try {
    await dependencies.assertDatabase(database, url, local);
    if (config.migrate) await dependencies.migrate(database, url, local);
    if (config.apply)
      await database.paperPreparation.create({
        accountId: config.accountId,
        planHash: base.planHash,
        cash: plan.cash,
        limits: plan.limits,
        strategyVersion: plan.strategyVersion,
        strategy: plan.strategy,
      });
    const report = checkPaperPreparation(plan, await database.paperPreparation.read(config.accountId));
    return { ...base, state: config.apply ? 'prepared-stopped' : 'checked', ...report };
  } finally {
    await database.close();
  }
}
