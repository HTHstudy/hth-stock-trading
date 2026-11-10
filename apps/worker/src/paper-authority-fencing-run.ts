import { paperModeSchema } from '@hth/contracts';

const safety = {
  syntheticOnly: true,
  documentApproval: false,
  operatingApproval: false,
  actualAuthorityVerified: false,
  currentAuthorityVerified: false,
  externalEvidenceAuthenticated: false,
  policyApplied: false,
  dbAccessed: false,
  canIgnoreReservation: false,
  scheduled: false,
  resumeRequested: false,
  automaticRetry: false,
  originalFilesRead: false,
  executionEnabled: false,
  canResume: false,
} as const;

async function main(): Promise<void> {
  paperModeSchema.parse(process.env.TRADING_MODE);
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.info(JSON.stringify({ state: 'preview', mode: 'preview', ...safety }));
    return;
  }

  let demo = false;
  let selectedCase: string | undefined;
  for (const arg of args) {
    if (arg === '--demo' && !demo) {
      demo = true;
    } else if (arg.startsWith('--case=') && selectedCase === undefined) {
      selectedCase = arg.slice('--case='.length);
    } else {
      throw new Error('PAPER_AUTHORITY_SIMULATION_INVALID');
    }
  }
  if (!demo) throw new Error('PAPER_AUTHORITY_SIMULATION_INVALID');

  const { paperAuthorityFencingDemoCases, createPaperAuthorityFencingDemo } =
    await import('./paper-authority-fencing-demo.js');
  const caseName = paperAuthorityFencingDemoCases.find((candidate) => candidate === (selectedCase ?? 'complete'));
  if (caseName === undefined) throw new Error('PAPER_AUTHORITY_SIMULATION_INVALID');
  const { evaluatePaperAuthorityFencingSimulation } = await import('./paper-authority-fencing-simulation.js');
  const result = evaluatePaperAuthorityFencingSimulation(createPaperAuthorityFencingDemo(caseName));
  if (result.state !== 'consistent-synthetic-scenario' && result.state !== 'blocked') {
    throw new Error('PAPER_AUTHORITY_SIMULATION_INVALID');
  }
  console.info(JSON.stringify({ ...result, mode: 'demo', case: caseName, ...safety }));
  process.exitCode = result.state === 'blocked' ? 2 : 0;
}

main().catch(() => {
  console.error(JSON.stringify({ code: 'PAPER_AUTHORITY_SIMULATION_INVALID', ...safety }));
  process.exitCode = 1;
});
