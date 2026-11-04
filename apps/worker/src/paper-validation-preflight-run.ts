import { runPaperValidationPreflight } from './paper-validation-preflight.js';
import { paperValidationFailureCode } from './paper-validation-resources.js';
runPaperValidationPreflight(process.argv.slice(2), process.env)
  .then((result) => console.info(JSON.stringify(result)))
  .catch((error) => {
    console.error(
      JSON.stringify({
        service: 'paper-validation-preflight',
        code: paperValidationFailureCode(error),
        executionEnabled: false,
      }),
    );
    process.exitCode = 1;
  });
