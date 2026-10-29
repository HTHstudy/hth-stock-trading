import {
  paperDashboardStateSchema,
  paperStrategyAcknowledgementSchema,
  paperStrategyUpdateSchema,
} from '@hth/contracts';
import type { PaperDashboardState } from '@hth/contracts';
import type { createDatabase } from '@hth/database';

export interface PaperDashboard {
  read(): Promise<PaperDashboardState>;
  stop(): Promise<void>;
  updateStrategy(id: string, input: unknown): Promise<unknown>;
  close(): Promise<void>;
}
export function createPaperDashboard(
  database: ReturnType<typeof createDatabase>,
  accountId: string,
  expectedSource: 'synthetic-only' | 'toss-readonly' = 'synthetic-only',
): PaperDashboard {
  async function snapshot() {
    const value = await database.paper.readDashboard(accountId);
    if (value.source !== 'unverified' && value.source !== expectedSource) throw new Error('PAPER_SOURCE_MISMATCH');
    return value;
  }
  return {
    async read() {
      const value = await snapshot();
      return paperDashboardStateSchema.parse({
        status: 'ready',
        mode: 'paper',
        source: value.source,
        executionEnabled: false,
        snapshot: value,
      });
    },
    async stop() {
      await database.paper.stop(accountId, 'DASHBOARD_EMERGENCY_STOP');
    },
    async updateStrategy(id, input) {
      const current = await snapshot();
      if (current.source === 'unverified') throw new Error('PAPER_SOURCE_MISMATCH');
      const checked = paperStrategyUpdateSchema.parse(input);
      if (
        (current.source === 'synthetic-only' && checked.definition.instrument.market !== 'KR') ||
        (current.source === 'toss-readonly' && checked.definition.parameters.slowPeriod + 1 > 200)
      )
        throw new Error('PAPER_STRATEGY_SOURCE_UNSUPPORTED');
      const strategy = await database.paper.updateStrategy(accountId, id, input);
      return paperStrategyAcknowledgementSchema.parse({
        mode: 'paper',
        executionEnabled: false,
        stopped: true,
        strategy,
      });
    },
    close: () => database.close(),
  };
}
