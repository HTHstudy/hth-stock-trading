import { fileURLToPath } from 'node:url';
import { captureRunDiagnostics } from './paper-run-diagnostics-runtime.js';
captureRunDiagnostics(process.argv.slice(2), process.env, fileURLToPath(new URL('../../../', import.meta.url)))
  .then((result) => console.info(JSON.stringify(result)))
  .catch(() => {
    console.error(
      JSON.stringify({
        service: 'paper-run-diagnostics',
        code: 'PAPER_RUN_DIAGNOSTICS_FAILED',
        executionEnabled: false,
      }),
    );
    process.exitCode = 1;
  });
