import { runPaperReview } from './paper-review-runtime.js';
runPaperReview(process.argv.slice(2), process.env)
  .then((report) => {
    console.info(JSON.stringify(report));
    if ('verdict' in report && report.verdict !== 'consistent-observed-state') process.exitCode = 2;
  })
  .catch(() => {
    console.error(JSON.stringify({ service: 'paper-review', code: 'PAPER_REVIEW_FAILED', executionEnabled: false }));
    process.exitCode = 1;
  });
