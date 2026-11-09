import { parseArgs } from 'node:util';
import { planReadonlyValidation } from './readonly-validation-plan.js';

function main() {
  if (process.argv.length === 2) {
    console.info(
      JSON.stringify({
        service: 'readonly-validation-plan',
        state: 'preview',
        kinds: ['session', 'expiry', 'regular'],
        required: ['kind', 'start-at', 'deadline', 'interval-seconds'],
        conditional: ['boundary-at (session)', 'ttl-seconds (expiry)', 'session-start/session-end (regular)'],
        reservation: ['reserved-start', 'reserved-end'],
        scheduled: false,
        executionEnabled: false,
        canResume: false,
      }),
    );
    return;
  }
  const seen = new Set<string>();
  for (const argument of process.argv.slice(2)) {
    if (!argument.startsWith('--')) continue;
    const key = argument.split('=')[0]!;
    if (seen.has(key)) throw new Error('INVALID_ARGUMENT');
    seen.add(key);
  }
  const { values } = parseArgs({
    options: {
      kind: { type: 'string' },
      'start-at': { type: 'string' },
      deadline: { type: 'string' },
      'interval-seconds': { type: 'string' },
      'boundary-at': { type: 'string' },
      'ttl-seconds': { type: 'string' },
      'session-start': { type: 'string' },
      'session-end': { type: 'string' },
      'reserved-start': { type: 'string' },
      'reserved-end': { type: 'string' },
    },
  });
  if (
    (values['reserved-start'] === undefined) !== (values['reserved-end'] === undefined) ||
    (values.kind === 'session' && values['ttl-seconds'] !== undefined) ||
    (values.kind === 'expiry' && values['boundary-at'] !== undefined) ||
    (values.kind === 'regular' && (values['ttl-seconds'] !== undefined || values['boundary-at'] !== undefined)) ||
    (values.kind !== 'regular' && (values['session-start'] !== undefined || values['session-end'] !== undefined))
  )
    throw new Error('INVALID_ARGUMENT');
  const plan = planReadonlyValidation({
    kind: values.kind,
    startsAt: values['start-at'],
    deadline: values.deadline,
    intervalSeconds: Number(values['interval-seconds']),
    reservedWindows: values['reserved-start']
      ? [{ startsAt: values['reserved-start'], endsAt: values['reserved-end'] }]
      : [],
    ...(values.kind === 'regular'
      ? { sessionStartsAt: values['session-start'], sessionEndsAt: values['session-end'] }
      : values.kind === 'session'
        ? { boundaryAt: values['boundary-at'] }
        : { observedTtlSeconds: Number(values['ttl-seconds']) }),
  });
  console.info(JSON.stringify(plan));
  if (plan.state === 'blocked') process.exitCode = 2;
}
try {
  main();
} catch {
  console.error(
    JSON.stringify({
      service: 'readonly-validation-plan',
      code: 'READONLY_VALIDATION_PLAN_INVALID',
      executionEnabled: false,
    }),
  );
  process.exitCode = 1;
}
