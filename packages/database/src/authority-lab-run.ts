import {
  authorityLabErrorCode,
  authorityLabMode,
  authorityLabSafety,
  runDatabaseAuthorityLab,
} from './authority-lab.js';

async function main() {
  const mode = authorityLabMode(process.argv.slice(2), process.env.TRADING_MODE);
  if (mode === 'preview') {
    console.info(JSON.stringify({ state: 'preview', ...authorityLabSafety }));
    return;
  }
  console.info(JSON.stringify(await runDatabaseAuthorityLab()));
}
main().catch((error: unknown) => {
  console.error(JSON.stringify({ code: authorityLabErrorCode(error), ...authorityLabSafety }));
  process.exitCode = 1;
});
