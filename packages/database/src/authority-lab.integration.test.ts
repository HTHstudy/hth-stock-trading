import { expect, it, vi } from 'vitest';
import { testDatabaseUrl } from './test-database.js';
import { authorityLabSafety, runDatabaseAuthorityLab } from './authority-lab.js';

// TEST_DATABASE_URL selects the established integration suite, never this experiment's target.
it.skipIf(!process.env.TEST_DATABASE_URL)(
  '새 일회용 PostgreSQL에서 접속·세션·준비 트랜잭션·역할 우회 경로를 검증한다',
  async () => {
    testDatabaseUrl();
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('NETWORK_FORBIDDEN'));
    try {
      expect(await runDatabaseAuthorityLab()).toEqual({
        state: 'passed',
        checks: {
          passwordRotationKeepsExistingSession: true,
          publicGrantBypassesDirectRevoke: true,
          connectRevocationKeepsExistingSessions: true,
          terminationRollsBackOpenTransaction: true,
          preparedTransactionOutlivesSessions: true,
          noLoginDoesNotBlockSetRole: true,
          membershipRemovalBlocksNewSetRole: true,
        },
        ...authorityLabSafety,
      });
      expect(network).not.toHaveBeenCalled();
    } finally {
      network.mockRestore();
    }
  },
  45000,
);
