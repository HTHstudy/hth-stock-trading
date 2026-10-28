import { paperDashboardStateSchema } from '@hth/contracts';
import type { PaperDashboardState } from '@hth/contracts';
import type { createDatabase } from '@hth/database';

export interface PaperDashboard {
  read(): Promise<PaperDashboardState>;
  stop(): Promise<void>;
  close(): Promise<void>;
}
export function createPaperDashboard(database: ReturnType<typeof createDatabase>, accountId: string): PaperDashboard {
  return {
    async read() {
      return paperDashboardStateSchema.parse({
        status: 'ready',
        mode: 'paper',
        source: 'synthetic-only',
        executionEnabled: false,
        snapshot: await database.paper.readDashboard(accountId),
      });
    },
    async stop() {
      await database.paper.stop(accountId, 'DASHBOARD_EMERGENCY_STOP');
    },
    close: () => database.close(),
  };
}
