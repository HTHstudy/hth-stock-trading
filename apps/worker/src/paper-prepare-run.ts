import { runPaperPreparation } from './paper-preparation.js';

runPaperPreparation(process.argv.slice(2), process.env)
  .then((report) => {
    console.info(JSON.stringify(report, null, 2));
    if ('preparationMatches' in report && !report.preparationMatches) process.exitCode = 1;
  })
  .catch(() => {
    console.error(
      JSON.stringify({ service: 'paper-preparation', code: 'PAPER_PREPARATION_FAILED', executionEnabled: false }),
    );
    process.exitCode = 1;
  });
