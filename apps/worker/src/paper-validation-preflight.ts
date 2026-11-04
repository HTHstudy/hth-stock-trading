import { parseArgs } from 'node:util';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { paperModeSchema } from '@hth/contracts';
import { createPaperValidationResources, checkPaperValidationPreparation } from './paper-validation-resources.js';

export async function runPaperValidationPreflight(args: string[], environment: Record<string, string | undefined>) {
  paperModeSchema.parse(environment.TRADING_MODE);
  const { values } = parseArgs({
    args,
    options: {
      pin: { type: 'boolean', default: false },
      check: { type: 'boolean', default: false },
      market: { type: 'string' },
      plan: { type: 'string' },
      'plan-hash': { type: 'string' },
      'output-root': { type: 'string' },
      resources: { type: 'string' },
      'resources-hash': { type: 'string' },
      account: { type: 'string' },
    },
  });
  const base = {
    service: 'paper-validation-preflight',
    executionEnabled: false,
    canResume: false,
    marketReadiness: 'not-checked',
  };
  if (!values.pin && !values.check) {
    if (Object.values(values).some((value) => value !== false && value !== undefined))
      throw new Error('PAPER_VALIDATION_RESOURCE_INVALID');
    return { ...base, state: 'preview' };
  }
  if (values.pin && values.check) throw new Error('PAPER_VALIDATION_RESOURCE_INVALID');
  const market = z.enum(['KR', 'US']).parse(values.market);
  const absolute = z.string().min(1).refine(isAbsolute);
  if (values.pin) {
    if (values.resources !== undefined || values['resources-hash'] !== undefined || values.account !== undefined)
      throw new Error('PAPER_VALIDATION_RESOURCE_INVALID');
    const result = await createPaperValidationResources(
      absolute.parse(values['output-root']),
      market,
      absolute.parse(values.plan),
      z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(values['plan-hash']),
    );
    return {
      ...base,
      state: 'inputs-pinned',
      market,
      resourcesHash: result.resourcesHash,
      id: result.directory.split(/[\\/]/).at(-1),
    };
  }
  if (values.plan !== undefined || values['plan-hash'] !== undefined || values['output-root'] !== undefined)
    throw new Error('PAPER_VALIDATION_RESOURCE_INVALID');
  const report = await checkPaperValidationPreparation(
    {
      directory: absolute.parse(values.resources),
      resourcesHash: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(values['resources-hash']),
      market,
      accountId: z
        .string()
        .regex(/^paper-market-[A-Za-z0-9._:-]{1,70}$/)
        .parse(values.account),
    },
    environment,
  );
  if (!('checks' in report)) throw new Error('PAPER_VALIDATION_RESOURCE_INVALID');
  return {
    ...base,
    state: 'account-checked',
    market,
    checks: report.checks,
    preparationMatches: report.preparationMatches,
  };
}
