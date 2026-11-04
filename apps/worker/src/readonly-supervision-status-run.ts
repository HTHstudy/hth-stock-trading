import { paperModeSchema } from '@hth/contracts';
import { createReadonlySupervisionStatus } from './readonly-supervision-status.js';

async function main() {
  if (process.argv.length !== 2 || !paperModeSchema.safeParse(process.env.TRADING_MODE).success)
    throw new Error('READONLY_SUPERVISION_STATUS_CONFIGURATION_INVALID');
  const result = await createReadonlySupervisionStatus().list();
  console.info(JSON.stringify(result));
  if (result.availability === 'unavailable' || result.rejectedCount > 0 || result.limited || result.clockUnverified)
    process.exitCode = 1;
}

main().catch(() => {
  console.error(
    JSON.stringify({
      service: 'readonly-supervision-status',
      code: 'READONLY_SUPERVISION_STATUS_CONFIGURATION_INVALID',
      executionEnabled: false,
      canResume: false,
      automaticRetry: false,
      processLivenessChecked: false,
    }),
  );
  process.exitCode = 1;
});
