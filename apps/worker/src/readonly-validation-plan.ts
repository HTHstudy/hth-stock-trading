import { z } from 'zod';

const instant = z.iso.datetime({ offset: true });
const windowSchema = z
  .strictObject({ startsAt: instant, endsAt: instant })
  .refine((window) => Date.parse(window.startsAt) < Date.parse(window.endsAt));
const common = {
  startsAt: instant,
  deadline: instant,
  intervalSeconds: z.number().int().min(10).max(3600),
  reservedWindows: z.array(windowSchema).max(100),
};
const inputSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...common, kind: z.literal('session'), boundaryAt: instant }),
  z.strictObject({ ...common, kind: z.literal('expiry'), observedTtlSeconds: z.number().int().min(1).max(172800) }),
]);

// Offline sizing only. Neither calendar/TTL input nor this plan grants execution permission.
export function planReadonlyValidation(input: unknown) {
  const value = inputSchema.parse(input);
  const start = Date.parse(value.startsAt),
    deadline = Date.parse(value.deadline);
  if (deadline <= start || deadline - start > 36 * 3600_000) throw new Error('INVALID_VALIDATION_WINDOW');
  const intervalMs = value.intervalSeconds * 1000;
  const target =
    value.kind === 'session' ? Date.parse(value.boundaryAt) + 300_000 : start + (value.observedTtlSeconds + 120) * 1000;
  if (value.kind === 'session' && Date.parse(value.boundaryAt) - start < intervalMs)
    throw new Error('INSUFFICIENT_PRE_BOUNDARY_WINDOW');
  const samples = Math.ceil((target - start) / intervalMs) + 1;
  if (samples < 2 || samples > 10_000) throw new Error('INVALID_VALIDATION_SAMPLE_COUNT');
  const minimumSamplingSpanMs = (samples - 1) * intervalMs;
  // Existing observer waits after each completed sample. Include every sample's 10s budget,
  // plus explicit startup/cleanup allowances. OS suspension and hung cleanup are not bounded here.
  const startupAllowanceMs = 30_000,
    cleanupAllowanceMs = 60_000,
    sampleTimeoutMs = 10_000;
  const plannedBudgetMs = startupAllowanceMs + minimumSamplingSpanMs + samples * sampleTimeoutMs + cleanupAllowanceMs;
  const blockers: Array<'DEADLINE_BUDGET_INSUFFICIENT' | 'RESERVED_WINDOW_OVERLAP'> = [];
  if (start + plannedBudgetMs > deadline) blockers.push('DEADLINE_BUDGET_INSUFFICIENT');
  if (
    value.reservedWindows.some((window) => start < Date.parse(window.endsAt) && Date.parse(window.startsAt) < deadline)
  )
    blockers.push('RESERVED_WINDOW_OVERLAP');
  return {
    formatVersion: 'readonly-validation-plan-v1' as const,
    kind: value.kind,
    state: blockers.length ? ('blocked' as const) : ('prepared' as const),
    startsAt: new Date(start).toISOString(),
    deadline: new Date(deadline).toISOString(),
    targetThrough: new Date(target).toISOString(),
    samples,
    intervalSeconds: value.intervalSeconds,
    sampleTimeoutMs,
    minimumSamplingSpanMs,
    startupAllowanceMs,
    cleanupAllowanceMs,
    plannedBudgetMs,
    estimatedBudgetEndsAt: new Date(start + plannedBudgetMs).toISOString(),
    // One instrument / one market / one candle page: instruments, quotes, calendar, FX, candles.
    sourceMethodCallsWithoutRetries: samples * 5,
    httpRequestCountKnown: false,
    blockers,
    reservedWindowCount: value.reservedWindows.length,
    observedTtlSeconds: value.kind === 'expiry' ? value.observedTtlSeconds : null,
    boundaryAt: value.kind === 'session' ? value.boundaryAt : null,
    regularOnly: false,
    tokenLifecycle: true,
    requiresDeadlineSupervisor: true,
    requiresFreshCalendar: true,
    requiresActualTtlReview: value.kind === 'expiry',
    scheduled: false,
    executionEnabled: false,
    canResume: false,
  };
}
