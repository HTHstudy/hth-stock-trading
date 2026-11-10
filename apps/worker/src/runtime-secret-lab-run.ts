import {
  runtimeSecretLabErrorCode,
  runtimeSecretLabMode,
  runtimeSecretLabSafety,
  runRuntimeSecretLab,
} from './runtime-secret-lab.js';
async function main() {
  if (runtimeSecretLabMode(process.argv.slice(2), process.env.TRADING_MODE) === 'preview') {
    console.info(JSON.stringify({ state: 'preview', ...runtimeSecretLabSafety }));
    return;
  }
  console.info(JSON.stringify(await runRuntimeSecretLab()));
}
main().catch((error: unknown) => {
  console.error(JSON.stringify({ code: runtimeSecretLabErrorCode(error), ...runtimeSecretLabSafety }));
  process.exitCode = 1;
});
