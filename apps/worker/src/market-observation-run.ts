import { createHash } from 'node:crypto';
import { createDatabase } from '@hth/database';
import { createTossReadonlyBroker } from '@hth/broker/toss';
import { parseMarketObservationConfig } from './market-observation-config.js';
import { createObservationFiles } from './market-observation-files.js';
import { runMarketObservation, observationFailureCode } from './market-observation.js';
import { createPaperMarketSource } from './paper-market-source.js';
import { createPaperSyntheticSource } from './paper-synthetic-source.js';
import { requireObservationSession, waitForObservationStart } from './market-observation-start.js';
import { shareDashboardBroker } from './shared-dashboard-broker.js';

async function main() {
  const config = parseMarketObservationConfig(process.argv.slice(2), process.env);
  const { source, instruments, samples, intervalMs, timeoutMs } = config;
  const settings = { source, instruments, samples, intervalMs, timeoutMs };
  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let database: ReturnType<typeof createDatabase> | null = null;
  let files: Awaited<ReturnType<typeof createObservationFiles>> | null = null;
  try {
    if (config.startAt) {
      console.info(
        JSON.stringify({
          service: 'market-observation',
          state: 'waiting',
          startsAt: config.startAt,
          executionEnabled: false,
        }),
      );
      try {
        await waitForObservationStart(config.startAt, shutdown.signal);
      } catch (error) {
        if (!shutdown.signal.aborted) throw error;
        console.info(JSON.stringify({ service: 'market-observation', state: 'cancelled', executionEnabled: false }));
        return;
      }
    }
    files = await createObservationFiles(config.outputDirectory, settings);
    const output = files;
    database = config.broker ? createDatabase(config.broker.DATABASE_URL) : null;
    const collect = async (leaseSignal: AbortSignal) => {
      const lifetime = new AbortController();
      const signal = AbortSignal.any([shutdown.signal, leaseSignal, lifetime.signal]);
      let sharing: Awaited<ReturnType<typeof shareDashboardBroker>> | undefined;
      try {
        const broker = config.broker
          ? createTossReadonlyBroker({
              clientId: config.broker.TOSS_CLIENT_ID,
              clientSecret: config.broker.TOSS_CLIENT_SECRET,
              signal,
            })
          : null;
        if (config.regularMarket && broker) {
          const calendar = await broker.getMarketCalendar(config.regularMarket);
          if (config.startAt && Date.now() - Date.parse(config.startAt) > 120_000)
            throw new Error('OBSERVATION_START_MISSED');
          requireObservationSession(calendar, config.regularMarket, settings, Date.now());
        }
        if (config.shareDashboard && broker && config.broker)
          sharing = await shareDashboardBroker(
            {
              clientId: config.broker.TOSS_CLIENT_ID,
              clientSecret: config.broker.TOSS_CLIENT_SECRET,
              databaseUrl: config.broker.DATABASE_URL,
              interval: config.broker.CANDLE_INTERVAL,
            },
            broker,
            signal,
          );
        return await runMarketObservation(
          settings,
          {
            createSource: (readLifetime) => {
              readLifetime.addEventListener('abort', () => lifetime.abort(), { once: true });
              return broker ? createPaperMarketSource(broker, 1) : createPaperSyntheticSource(21);
            },
            record: async (value) => {
              await output.record(value);
              if (process.env.WORKER_REPORT_PROGRESS === '1')
                console.info(
                  JSON.stringify({
                    service: 'worker-observation-progress',
                    state: 'observing',
                    samples: value.index,
                    executionEnabled: false,
                  }),
                );
            },
          },
          signal,
        );
      } finally {
        lifetime.abort();
        await sharing?.close();
      }
    };
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
    await files?.fail(error);
    throw error;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await files?.close();
    await database?.close();
  }
}
main().catch((error: unknown) => {
  console.error(
    JSON.stringify({ service: 'market-observation', code: observationFailureCode(error), executionEnabled: false }),
  );
  process.exitCode = 1;
});
