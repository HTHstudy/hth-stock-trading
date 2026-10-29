import { createHash } from 'node:crypto';
import { z } from 'zod';
import { paperRiskSnapshotSchema } from '@hth/contracts';
import type { createDatabase } from '@hth/database';
import { contentHash } from '@hth/database';
import type { ReadonlyBroker } from '@hth/broker';
import { marketTradingDate } from '@hth/trading';

const dates = z.object({ KRW: z.iso.date(), USD: z.iso.date() }).strict();
export const paperDayReviewPlanSchema = z
  .object({
    kind: z.literal('paper-day-review-v1'),
    accountId: z.string().regex(/^paper-market-[A-Za-z0-9._:-]{1,70}$/),
    source: z.literal('toss-readonly'),
    expectedVersion: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER - 2),
    dailyPnl: paperRiskSnapshotSchema.shape.dailyPnl,
    targetDates: dates,
    expiresAt: z.iso.datetime({ offset: true }),
    policy: z.literal('carry-negative-pnl-v1'),
  })
  .strict();
type Database = ReturnType<typeof createDatabase>;
type Plan = z.infer<typeof paperDayReviewPlanSchema>;
const targets = (asOf: string) => ({
  KRW: marketTradingDate(Date.parse(asOf), 'KR'),
  USD: marketTradingDate(Date.parse(asOf), 'US'),
});
export async function planPaperDayReview(
  paper: Pick<Database['paper'], 'readAccount' | 'readOpenIntents'>,
  accountId: string,
): Promise<Plan> {
  const current = await paper.readAccount(accountId);
  if (
    current.source !== 'toss-readonly' ||
    !current.control.stopped ||
    (current.leaseUntil && Date.parse(current.leaseUntil) > Date.parse(current.asOf))
  )
    throw new Error('PAPER_REVIEW_REQUIRES_STOP');
  if ((await paper.readOpenIntents(accountId)).length) throw new Error('PAPER_RECOVERY_PENDING');
  const targetDates = targets(current.asOf);
  if (
    current.snapshot.dailyPnl.KRW.tradingDate === targetDates.KRW &&
    current.snapshot.dailyPnl.USD.tradingDate === targetDates.USD
  )
    throw new Error('PAPER_TRADING_DAY_REVIEW_NOT_REQUIRED');
  return paperDayReviewPlanSchema.parse({
    kind: 'paper-day-review-v1',
    accountId,
    source: current.source,
    expectedVersion: current.snapshot.version,
    dailyPnl: current.snapshot.dailyPnl,
    targetDates,
    expiresAt: new Date(Date.parse(current.asOf) + 300000).toISOString(),
    policy: 'carry-negative-pnl-v1',
  });
}

export async function applyPaperDayReview(
  dependencies: {
    paper: Pick<
      Database['paper'],
      'readAccount' | 'readOpenIntents' | 'acquireLease' | 'releaseLease' | 'reviewTradingDay'
    >;
    withBrokerLease: Database['withBrokerLease'];
    createBroker: (signal: AbortSignal) => Pick<ReadonlyBroker, 'getQuotes'>;
    clientId: string;
  },
  value: unknown,
  acknowledgement: string,
  signal: AbortSignal,
) {
  const plan = paperDayReviewPlanSchema.parse(value);
  if (acknowledgement !== 'CARRY_FORWARD_PAPER_LOSSES') throw new Error('PAPER_REVIEW_ACKNOWLEDGEMENT_REQUIRED');
  signal.throwIfAborted();
  const key = createHash('sha256').update(dependencies.clientId).digest().readInt32BE(0);
  await dependencies.withBrokerLease(key, async (leaseSignal) => {
    const lifetime = new AbortController();
    const combined = AbortSignal.any([signal, leaseSignal, lifetime.signal, AbortSignal.timeout(10000)]);
    let token: string | undefined;
    let complete = false;
    try {
      combined.throwIfAborted();
      const current = await dependencies.paper.readAccount(plan.accountId);
      const targetDates = targets(current.asOf);
      if (
        Date.parse(current.asOf) >= Date.parse(plan.expiresAt) ||
        contentHash(targetDates) !== contentHash(plan.targetDates)
      )
        throw new Error('PAPER_REVIEW_EXPIRED');
      if (
        current.source !== plan.source ||
        !current.control.stopped ||
        contentHash(current.snapshot.dailyPnl) !== contentHash(plan.dailyPnl)
      )
        throw new Error('PAPER_REVIEW_CONFLICT');
      if ((await dependencies.paper.readOpenIntents(plan.accountId)).length) throw new Error('PAPER_RECOVERY_PENDING');
      const lease = await dependencies.paper.acquireLease(plan.accountId, 30000, plan.source, plan.expectedVersion);
      token = lease.token;
      const acquired = await dependencies.paper.readAccount(plan.accountId);
      const instruments = acquired.snapshot.positions.map((position) => position.instrument);
      const observedAt = acquired.asOf;
      const quotes = instruments.length ? await dependencies.createBroker(combined).getQuotes(instruments) : [];
      combined.throwIfAborted();
      if (quotes.some((quote) => quote.currency !== (quote.instrument.market === 'KR' ? 'KRW' : 'USD')))
        throw new Error('PAPER_SOURCE_CURRENCY_MISMATCH');
      await dependencies.paper.reviewTradingDay(plan.accountId, token, lease.epoch, {
        expectedVersion: acquired.snapshot.version,
        targetDates: plan.targetDates,
        acknowledgement,
        observation: {
          quotes: quotes.map((quote) => ({
            instrument: quote.instrument,
            price: quote.price,
            timestamp: quote.timestamp,
            observedAt,
          })),
          sourcesHealthy: true,
          hasUnknownOrders: false,
        },
      });
      complete = true;
    } finally {
      lifetime.abort();
      if (token)
        await dependencies.paper.releaseLease(
          plan.accountId,
          token,
          complete ? 'DAILY_REVIEW_COMPLETED' : 'DAILY_REVIEW_FAILED',
        );
    }
  });
}
