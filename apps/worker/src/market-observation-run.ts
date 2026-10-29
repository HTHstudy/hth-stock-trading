import { createHash } from 'node:crypto';
import { createDatabase } from '@hth/database';
import { createTossReadonlyBroker } from '@hth/broker/toss';
import { parseMarketObservationConfig } from './market-observation-config.js';
import { createObservationFiles } from './market-observation-files.js';
import { runMarketObservation, observationFailureCode } from './market-observation.js';
import { createPaperMarketSource } from './paper-market-source.js';
import { createPaperSyntheticSource } from './paper-synthetic-source.js';

async function main() {
  const config = parseMarketObservationConfig(process.argv.slice(2), process.env);
  const { source, instruments, samples, intervalMs, timeoutMs } = config;
  const settings = { source, instruments, samples, intervalMs, timeoutMs };
  const files = await createObservationFiles(config.outputDirectory, settings);
  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let database: ReturnType<typeof createDatabase> | null = null;
  try {
    database = config.broker ? createDatabase(config.broker.DATABASE_URL) : null;
    const collect = (leaseSignal: AbortSignal) =>
      runMarketObservation(
        settings,
        {
          createSource: (signal) =>
            config.broker
              ? createPaperMarketSource(
                  createTossReadonlyBroker({
                    clientId: config.broker.TOSS_CLIENT_ID,
                    clientSecret: config.broker.TOSS_CLIENT_SECRET,
                    signal,
                  }),
                  1,
                )
              : createPaperSyntheticSource(21),
          record: files.record,
        },
        AbortSignal.any([shutdown.signal, leaseSignal]),
      );
    const summary =
      database && config.broker
        ? await database.withBrokerLease(
            createHash('sha256').update(config.broker.TOSS_CLIENT_ID).digest().readInt32BE(0),
            collect,
          )
        : await collect(shutdown.signal);
    await files.finish(summary);
    console.info(
      JSON.stringify({
        service: 'market-observation',
        runId: files.id,
        source,
        state: summary.status,
        samples: summary.samples,
        errorSamples: summary.errorSamples,
        executionEnabled: false,
      }),
    );
    if (summary.status === 'failed') process.exitCode = 1;
  } catch (error) {
    await files.fail(error);
    throw error;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await files.close();
    await database?.close();
  }
}
main().catch((error: unknown) => {
  console.error(
    JSON.stringify({ service: 'market-observation', code: observationFailureCode(error), executionEnabled: false }),
  );
  process.exitCode = 1;
});
