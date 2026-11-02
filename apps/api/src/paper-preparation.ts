import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { paperPreparationDashboardSchema } from '@hth/contracts';
import type { PaperPreparationDashboard } from '@hth/contracts';
import type { createDatabase } from '@hth/database';
import {
  checkPaperPreparation,
  verifyPaperMarketPlan,
  preparationTradingDates,
} from '@hth/worker/paper-preparation-query';

const manifestSchema = z
  .object({
    formatVersion: z.literal('paper-preparation-batch-v1'),
    createdAt: z.iso.datetime({ offset: true }),
    entries: z
      .array(
        z
          .object({
            market: z.enum(['kr', 'us']),
            accountId: z.string().regex(/^paper-market-[A-Za-z0-9._:-]{1,70}$/),
            planHash: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .length(2),
  })
  .strict()
  .refine(
    (v) => new Set(v.entries.map((e) => e.market)).size === 2 && new Set(v.entries.map((e) => e.accountId)).size === 2,
  );

async function readJson(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 65536) throw new Error('INVALID_PREPARATION_FILE');
    const buffer = Buffer.alloc(65537);
    let size = 0;
    while (size < buffer.length) {
      const part = await file.read(buffer, size, buffer.length - size, size);
      if (!part.bytesRead) break;
      size += part.bytesRead;
    }
    if (size > 65536) throw new Error('INVALID_PREPARATION_FILE');
    return JSON.parse(buffer.subarray(0, size).toString('utf8')) as unknown;
  } finally {
    await file.close();
  }
}
type Store = Pick<ReturnType<typeof createDatabase>['paperPreparation'], 'read'>;
export function createPaperPreparationDashboard(
  store: Store,
  directory: string,
  plansDirectory: string,
  close: () => Promise<void>,
  now: () => number = Date.now,
) {
  return {
    async read(): Promise<PaperPreparationDashboard> {
      const asOf = new Date(now()).toISOString();
      const base = {
        asOf,
        executionEnabled: false as const,
        canResume: false as const,
        marketReadiness: 'not-checked' as const,
      };
      try {
        const info = await lstat(directory);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('INVALID_DIRECTORY');
        const canonical = await realpath(directory);
        const manifest = manifestSchema.parse(await readJson(join(directory, 'accounts.json')));
        if ((await realpath(directory)) !== canonical) throw new Error('INVALID_DIRECTORY');
        const accounts: PaperPreparationDashboard['accounts'] = [];
        for (const market of ['KR', 'US'] as const) {
          const entry = manifest.entries.find((item) => item.market === market.toLowerCase())!;
          try {
            const plan = verifyPaperMarketPlan(
              await readJson(join(plansDirectory, `paper-market-${entry.market}-validation-v1.json`)),
              entry.planHash,
            );
            if (plan.strategy.instrument.market !== market) throw new Error('MARKET_MISMATCH');
            const before = now();
            const stored = await store.read(entry.accountId);
            const after = now();
            if (
              stored.account.id !== entry.accountId ||
              stored.account.mode !== 'paper' ||
              stored.account.dataSource !== 'toss-readonly'
            )
              throw new Error('SOURCE_MISMATCH');
            const observed = Date.parse(stored.asOf);
            const clockVerified =
              Number.isFinite(observed) && after >= before && observed >= before - 5000 && observed <= after + 5000;
            const checked = checkPaperPreparation(plan, stored);
            const dailyDates = (['KRW', 'USD'] as const).map((currency) => ({
              currency,
              stored: stored.account.ledger.dailyPnl[currency].tradingDate,
              current: preparationTradingDates(stored.asOf)[currency],
            }));
            const currency = market === 'KR' ? 'KRW' : 'USD';
            const details = {
              observedAt: stored.asOf,
              clockVerified,
              ...checked,
              stopped: stored.account.stopped,
              leasePresent: stored.account.leaseToken !== null || stored.account.leaseUntil !== null,
              dailyReviewRequired: clockVerified ? dailyDates.some((date) => date.stored !== date.current) : null,
              dailyDates,
              plan: {
                hash: entry.planHash,
                symbol: plan.strategy.instrument.symbol,
                currency,
                cash: plan.cash[currency],
                maxOrderAmount: plan.limits[currency].maxOrderAmount,
                maxInstrumentAmount: plan.limits[currency].maxInstrumentAmount,
                maxDailyLoss: plan.limits[currency].maxDailyLoss,
                maxPositions: plan.limits.maxPositions,
                ...plan.strategy.parameters,
                quantity: plan.strategy.quantity,
                maxFillQuantity: plan.strategy.maxFillQuantity,
              },
            };
            // Costs are not part of this DTO; never spread raw account/strategy/audit fields.
            const item = paperPreparationDashboardSchema.shape.accounts.element.parse({
              market,
              status: 'available',
              details,
            });
            accounts.push(item);
          } catch {
            accounts.push({ market, status: 'unavailable', details: null });
          }
        }
        return paperPreparationDashboardSchema.parse({
          ...base,
          status: accounts.every((a) => a.status === 'available') ? 'ready' : 'unavailable',
          accounts,
        });
      } catch {
        return paperPreparationDashboardSchema.parse({ ...base, status: 'unavailable', accounts: [] });
      }
    },
    close,
  };
}
export type PaperPreparationDashboardReader = ReturnType<typeof createPaperPreparationDashboard>;
