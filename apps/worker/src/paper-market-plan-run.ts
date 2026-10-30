import { parseArgs } from 'node:util';
import { paperModeSchema } from '@hth/contracts';
import { contentHash } from '@hth/database';
import { readPaperMarketPlan } from './paper-market-plan.js';

async function main() {
  paperModeSchema.parse(process.env.TRADING_MODE);
  const { values } = parseArgs({ options: { plan: { type: 'string' } } });
  if (!values.plan) throw new Error('PLAN_REQUIRED');
  const plan = await readPaperMarketPlan(values.plan);
  console.info(
    JSON.stringify(
      {
        service: 'paper-market-plan',
        state: 'preview',
        executionEnabled: false,
        planHash: contentHash(plan),
        plan,
        checksRequired: [
          'market-observation-review',
          'paused-account-observation',
          'daily-loss-review',
          'separate-paper-resume',
        ],
        warnings: ['VALIDATION_SETTINGS_ONLY', 'NO_PRICE_OR_BUYING_POWER_CHECK', 'NO_TRADING_AUTHORIZATION'],
      },
      null,
      2,
    ),
  );
}
main().catch(() => {
  console.error(
    JSON.stringify({ service: 'paper-market-plan', code: 'PAPER_MARKET_PLAN_INVALID', executionEnabled: false }),
  );
  process.exitCode = 1;
});
