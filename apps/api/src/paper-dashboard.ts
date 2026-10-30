import {
  paperDashboardStateSchema,
  paperStrategyAcknowledgementSchema,
  paperStrategyUpdateSchema,
  paperStrategyHistorySchema,
  paperEquityHistorySchema,
  paperDiagnosticsSchema,
} from '@hth/contracts';
import type { PaperDashboardState } from '@hth/contracts';
import type { createDatabase } from '@hth/database';

export interface PaperDashboard {
  read(): Promise<PaperDashboardState>;
  stop(): Promise<void>;
  updateStrategy(id: string, input: unknown): Promise<unknown>;
  strategyHistory(id: string, query: unknown): Promise<unknown>;
  equityHistory(): Promise<unknown>;
  diagnostics(): Promise<unknown>;
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
    async diagnostics() {
      const value = await database.paper.readDiagnostics(accountId);
      if (value.source !== 'unverified' && value.source !== expectedSource) throw new Error('PAPER_SOURCE_MISMATCH');
      return paperDiagnosticsSchema.parse(value);
    },
    async equityHistory() {
      const value = await database.paper.readEquityHistory(accountId);
      if (value.source !== 'unverified' && value.source !== expectedSource) throw new Error('PAPER_SOURCE_MISMATCH');
      return paperEquityHistorySchema.parse(value);
    },
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
    async strategyHistory(id, query) {
      const history = await database.paper.readStrategyHistory(accountId, id, query);
      if (history.source !== 'unverified' && history.source !== expectedSource)
        throw new Error('PAPER_SOURCE_MISMATCH');
      return paperStrategyHistorySchema.parse(history);
    },
    close: () => database.close(),
  };
}
