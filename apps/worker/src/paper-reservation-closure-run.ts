import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { paperModeSchema } from '@hth/contracts';
import { createPaperReservationClosures } from './paper-reservation-closure-store.js';

async function main() {
  paperModeSchema.parse(process.env.TRADING_MODE);
  if (process.argv.length === 2) {
    console.info(
      JSON.stringify({
        service: 'paper-reservation-closure',
        state: 'preview',
        originalModified: false,
        executionEnabled: false,
        canResume: false,
      }),
    );
    return;
  }
  const seen = new Set<string>();
  for (const arg of process.argv.slice(2)) {
    if (!arg.startsWith('--')) continue;
    const key = arg.split('=')[0]!;
    if (seen.has(key)) throw Error('INVALID_ARGUMENT');
    seen.add(key);
  }
  const { values } = parseArgs({
    options: {
      inspect: { type: 'boolean' },
      apply: { type: 'boolean' },
      'run-id': { type: 'string' },
      'launch-id': { type: 'string' },
      'plan-hash': { type: 'string' },
      confirm: { type: 'string' },
    },
  });
  if (Boolean(values.inspect) === Boolean(values.apply) || !values['run-id'] || (values.apply && !values['launch-id']))
    throw Error('INVALID_ARGUMENT');
  z.uuid().parse(values['run-id']);
  if (values.inspect && !values['launch-id']) {
    console.info(
      JSON.stringify({
        service: 'paper-reservation-closure',
        state: 'blocked',
        code: 'PAPER_CLOSURE_OWNED_EXIT_REQUIRED',
        executionEnabled: false,
        canResume: false,
      }),
    );
    process.exitCode = 2;
    return;
  }
  const launchId = z.uuid().parse(values['launch-id']);
  const store = createPaperReservationClosures(fileURLToPath(new URL('../../../', import.meta.url)));
  const result = values.apply
    ? await store.apply(values['run-id'], launchId, values['plan-hash'] ?? '', values.confirm ?? '')
    : await store.inspect(values['run-id'], launchId);
  console.info(JSON.stringify({ service: 'paper-reservation-closure', ...result }));
}
main().catch(() => {
  console.error(
    JSON.stringify({
      service: 'paper-reservation-closure',
      code: 'PAPER_CLOSURE_BLOCKED',
      executionEnabled: false,
      canResume: false,
    }),
  );
  process.exitCode = 1;
});
