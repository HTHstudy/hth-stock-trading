import { paperControlSchema } from '@hth/contracts';
import type { PaperControl } from '@hth/contracts';

export function initialPaperControl(): PaperControl {
  return { mode: 'paper', stopped: true, epoch: 0, reason: 'INITIAL_STOP' };
}
export function stopPaperControl(value: unknown, reason: string): PaperControl {
  const control = paperControlSchema.safeParse(value);
  if (!control.success || !reason.trim() || reason.length > 200) throw new Error('INVALID_PAPER_CONTROL');
  return paperControlSchema.parse({
    ...control.data,
    stopped: true,
    epoch: Math.min(control.data.epoch + 1, Number.MAX_SAFE_INTEGER - 1),
    reason,
  });
}
