import { parseArgs } from 'node:util';
import { paperModeSchema } from '@hth/contracts';
import { planPaperWarmup } from './paper-warmup.js';
try {
  paperModeSchema.parse(process.env.TRADING_MODE);
  if (process.argv.length === 2)
    console.info(
      JSON.stringify({
        service: 'paper-warmup-plan',
        state: 'preview',
        required: ['session-start', 'session-end', 'fast-period', 'slow-period'],
        executionEnabled: false,
        canResume: false,
      }),
    );
  else {
    const seen = new Set<string>();
    for (const arg of process.argv.slice(2)) {
      if (!arg.startsWith('--')) continue;
      const name = arg.split('=')[0]!;
      if (seen.has(name)) throw Error('INVALID_ARGUMENT');
      seen.add(name);
    }
    const { values } = parseArgs({
      options: {
        'session-start': { type: 'string' },
        'session-end': { type: 'string' },
        'start-at': { type: 'string' },
        deadline: { type: 'string' },
        'fast-period': { type: 'string' },
        'slow-period': { type: 'string' },
      },
    });
    const result = planPaperWarmup({
      parameters: { fastPeriod: Number(values['fast-period']), slowPeriod: Number(values['slow-period']) },
      sessionStartsAt: values['session-start'],
      sessionEndsAt: values['session-end'],
      ...(values['start-at'] ? { requestedStartAt: values['start-at'] } : {}),
      ...(values.deadline ? { deadline: values.deadline } : {}),
    });
    console.info(JSON.stringify(result));
    if (result.state === 'blocked') process.exitCode = 2;
  }
} catch {
  console.error(
    JSON.stringify({ service: 'paper-warmup-plan', code: 'PAPER_WARMUP_CONFIG_INVALID', executionEnabled: false }),
  );
  process.exitCode = 1;
}
