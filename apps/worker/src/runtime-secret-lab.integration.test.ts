import { expect, it, vi } from 'vitest';
import { testDatabaseUrl } from '@hth/database/testing';
import { runRuntimeSecretLab, runtimeSecretLabSafety } from './runtime-secret-lab.js';

// Uses the established integration-suite switch, not its DB as an experiment target.
it.skipIf(!process.env.TEST_DATABASE_URL)(
  '일회용 컨테이너의 UID·마운트·파일 접근 경계 8조건을 재현한다',
  async () => {
    testDatabaseUrl();
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('NETWORK_FORBIDDEN'));
    try {
      expect(await runRuntimeSecretLab()).toEqual({
        state: 'passed',
        checks: {
          sameUidSharedRead: true,
          sameUidPrivateDirectoryRead: true,
          differentUidFileDenied: true,
          differentUidDirectoryDenied: true,
          worldReadableBypassesUidSeparation: true,
          unmountedSecretAbsent: true,
          readOnlyMountStillReadable: true,
          readOnlyWriteDeniedAndContentPreserved: true,
        },
        ...runtimeSecretLabSafety,
      });
      expect(network).not.toHaveBeenCalled();
    } finally {
      network.mockRestore();
    }
  },
  45000,
);
