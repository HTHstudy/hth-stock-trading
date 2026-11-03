import { fileURLToPath } from 'node:url';
import { paperModeSchema } from '@hth/contracts';
import { createPaperValidationStatus } from './paper-validation-status.js';

async function main() {
  if (process.argv.length !== 2 || !paperModeSchema.safeParse(process.env.TRADING_MODE).success)
    throw new Error('PAPER_VALIDATION_STATUS_CONFIGURATION_INVALID');
  const status = await createPaperValidationStatus(
    fileURLToPath(new URL('../../../.local-data/paper-validation-runs', import.meta.url)),
  ).list();
  console.info(JSON.stringify(status));
  if (status.availability === 'unavailable') process.exitCode = 1;
}
main().catch(() => {
  console.error(
    JSON.stringify({
      service: 'paper-validation-status',
      code: 'PAPER_VALIDATION_STATUS_CONFIGURATION_INVALID',
      executionEnabled: false,
      canResume: false,
    }),
  );
  process.exitCode = 1;
});
