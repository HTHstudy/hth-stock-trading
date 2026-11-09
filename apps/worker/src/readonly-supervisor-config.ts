import { parseArgs } from 'node:util';
import { z } from 'zod';
import { observationJobSchema, paperModeSchema } from '@hth/contracts';
import { marketTradingDate } from '@hth/trading';
import { parseReadonlySymbols } from './readonly-config.js';
import { planReadonlyValidation } from './readonly-validation-plan.js';

export function parseReadonlySupervisor(args: string[], environment: Record<string, string | undefined>) {
  paperModeSchema.parse(environment.TRADING_MODE);
  const seen = new Set<string>();
  for (const argument of args) {
    if (!argument.startsWith('--')) continue;
    const key = argument.split('=')[0]!;
    if (seen.has(key)) throw new Error('SUPERVISOR_CONFIG_INVALID');
    seen.add(key);
  }
  const { values } = parseArgs({
    args,
    options: {
      execute: { type: 'boolean', default: false },
      fingerprint: { type: 'boolean', default: false },
      source: { type: 'string', default: 'demo' },
      symbol: { type: 'string' },
      kind: { type: 'string' },
      'start-at': { type: 'string' },
      deadline: { type: 'string' },
      'interval-seconds': { type: 'string' },
      'boundary-at': { type: 'string' },
      'ttl-seconds': { type: 'string' },
      'session-start': { type: 'string' },
      'session-end': { type: 'string' },
      'job-id': { type: 'string' },
      'reserved-start': { type: 'string' },
      'reserved-end': { type: 'string' },
      'plan-hash': { type: 'string' },
      'build-hash': { type: 'string' },
    },
  });
  const source = z.enum(['demo', 'market']).parse(values.source);
  if (
    (values.fingerprint && (args.length !== 1 || values.execute)) ||
    (source === 'demo' && values.symbol !== undefined)
  )
    throw new Error('SUPERVISOR_CONFIG_INVALID');
  const instruments = parseReadonlySymbols(source === 'demo' ? 'KR:005930' : values.symbol);
  if (instruments.length !== 1 || (source === 'market' && !values.symbol)) throw new Error('SUPERVISOR_CONFIG_INVALID');
  if (
    (values['reserved-start'] === undefined) !== (values['reserved-end'] === undefined) ||
    (values.kind === 'session' && values['ttl-seconds'] !== undefined) ||
    (values.kind === 'expiry' && values['boundary-at'] !== undefined) ||
    (values.kind === 'regular' && (values['ttl-seconds'] !== undefined || values['boundary-at'] !== undefined)) ||
    (values.kind !== 'regular' &&
      (values['session-start'] !== undefined || values['session-end'] !== undefined || values['job-id'] !== undefined))
  )
    throw new Error('SUPERVISOR_CONFIG_INVALID');
  if (
    values.kind === undefined &&
    ['start-at', 'deadline', 'interval-seconds', 'boundary-at', 'ttl-seconds', 'reserved-start', 'reserved-end'].some(
      (key) => values[key as keyof typeof values] !== undefined,
    )
  )
    throw new Error('SUPERVISOR_CONFIG_INVALID');
  const plan =
    values.kind === undefined && !values.execute
      ? null
      : planReadonlyValidation({
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
  const observationJobId =
    values.kind === 'regular' ? observationJobSchema.shape.id.parse(values['job-id']) : undefined;
  if (
    observationJobId !== undefined &&
    (!observationJobId.startsWith(`${instruments[0]!.market.toLowerCase()}-`) ||
      observationJobId.slice(3, 13) !== marketTradingDate(Date.parse(plan!.startsAt), instruments[0]!.market))
  )
    throw new Error('SUPERVISOR_CONFIG_INVALID');
  return {
    execute: values.execute,
    fingerprint: values.fingerprint,
    source,
    instrument: instruments[0]!,
    plan,
    expectedPlanHash: values['plan-hash'],
    expectedBuildHash: values['build-hash'],
    ...(observationJobId !== undefined ? { observationJobId } : {}),
  };
}
