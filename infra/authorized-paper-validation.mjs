import { readFile, mkdir, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnv, parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID, createHash } from 'node:crypto';
async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      market: { type: 'string' },
      'build-root': { type: 'string' },
      'run-id': { type: 'string' },
      'build-hash': { type: 'string' },
      run: { type: 'boolean' },
      'resume-authorized': { type: 'boolean' },
      'verify-inputs': { type: 'boolean' },
      fingerprint: { type: 'boolean' },
      'selfcheck-control': { type: 'boolean' },
      prerequisite: { type: 'string' },
      'start-at': { type: 'string' },
      deadline: { type: 'string' },
      resources: { type: 'string' },
      'resources-hash': { type: 'string' },
      expectations: { type: 'string' },
      'expectations-hash': { type: 'string' },
    },
  });
  const seen = new Set();
  for (const argument of process.argv.slice(2)) {
    if (!argument.startsWith('--')) continue;
    const flag = argument.split('=')[0];
    if (seen.has(flag)) throw new Error('PAPER_PREFLIGHT_FAILED');
    seen.add(flag);
  }
  const root = process.cwd(),
    buildRoot = resolve(values['build-root'] ?? root),
    load = (p) => import(pathToFileURL(resolve(buildRoot, p)));
  const market = values.market;
  if (!['KR', 'US'].includes(market)) throw new Error('MARKET_REQUIRED');
  async function fingerprint() {
    const hash = createHash('sha256');
    const walk = async (folder) => {
      for (const entry of (await readdir(folder, { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        const path = resolve(folder, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile() && entry.name.endsWith('.js')) {
          hash.update(path.slice(buildRoot.length));
          hash.update(await readFile(path));
        }
      }
    };
    for (const path of [
      'packages/contracts/dist',
      'packages/broker/dist',
      'packages/trading/dist',
      'packages/database/dist',
      'apps/worker/dist',
      'apps/api/dist',
    ])
      await walk(resolve(buildRoot, path));
    hash.update(await readFile(resolve(buildRoot, 'pnpm-lock.yaml')));
    hash.update(await readFile(new URL(import.meta.url)));
    return hash.digest('hex');
  }
  if (
    values['run-id'] &&
    (!values.run ||
      !values['resume-authorized'] ||
      values.fingerprint ||
      values['verify-inputs'] ||
      values['selfcheck-control'] ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(values['run-id']))
  )
    throw new Error('PAPER_PREFLIGHT_FAILED');
  if (values.fingerprint) {
    console.log(await fingerprint());
    process.exit(0);
  }
  const expectedBuild = values['build-hash'];
  const resumeAuthorized = values.run && values['resume-authorized'];
  const prerequisite = values.prerequisite ?? null;
  const startsAt = values['start-at'] ?? null;
  const deadline = Date.parse(values.deadline ?? '');
  function verifyDailyControl(before, after, applied) {
    // Pinned backend: acquire/review/release each advance version and epoch once.
    const advance = applied ? 3 : 0;
    if (after.version !== before.version + advance || after.epoch !== before.epoch + advance)
      throw new Error('PAPER_CONTROL_CHANGED');
  }
  function verifyStoppedControl(before, after) {
    // Stopped regular-session worker advances epoch only on acquire/release.
    if (after.epoch !== before.epoch + 2) throw new Error('PAPER_CONTROL_CHANGED');
  }
  if (values['selfcheck-control']) {
    const before = { version: 10, epoch: 4 };
    verifyDailyControl(before, { version: 13, epoch: 7 }, true);
    verifyDailyControl(before, { version: 10, epoch: 4 }, false);
    verifyStoppedControl(before, { version: 15, epoch: 6 });
    for (const operation of [
      () => verifyDailyControl(before, { version: 14, epoch: 8 }, true),
      () => verifyDailyControl(before, { version: 11, epoch: 5 }, false),
      () => verifyStoppedControl(before, { version: 16, epoch: 7 }),
    ]) {
      let rejected = false;
      try {
        operation();
      } catch (error) {
        rejected = error.message === 'PAPER_CONTROL_CHANGED';
      }
      if (!rejected) throw new Error('CONTROL_SELFCHECK_FAILED');
    }
    console.log(
      JSON.stringify({
        ownTransitionsAccepted: 3,
        externalControlChangesRejected: 3,
        dbAccessed: false,
        executionEnabled: false,
      }),
    );
    process.exit(0);
  }
  if (!resumeAuthorized && !values['verify-inputs']) {
    console.log(
      JSON.stringify({
        state: 'preview',
        market,
        prerequisite,
        startsAt,
        maxTicks: 60,
        resumeRequested: false,
        executionEnabled: false,
      }),
    );
    process.exit(0);
  }
  const resourceDirectory = values.resources;
  const resourcesHash = values['resources-hash'];
  const { verifyPaperValidationResources, checkPaperValidationPreparation, paperValidationFailureCode } = await load(
    'apps/worker/dist/paper-validation-resources.js',
  );
  const resource = await verifyPaperValidationResources(resourceDirectory ?? '', resourcesHash ?? '', market);
  if (values['verify-inputs']) {
    console.log(
      JSON.stringify({
        state: 'inputs-verified',
        market,
        resourcesHash: resource.resourcesHash,
        dbAccessed: false,
        executionEnabled: false,
        canResume: false,
      }),
    );
    return;
  }
  try {
    const { instantSchema, observationJobSchema } = await load('packages/contracts/dist/index.js');
    instantSchema.parse(values.deadline);
    if (startsAt) instantSchema.parse(startsAt);
    observationJobSchema.shape.id.parse(prerequisite);
  } catch {
    throw new Error('PAPER_PREFLIGHT_FAILED');
  }
  if (
    !Number.isFinite(deadline) ||
    deadline <= Date.now() ||
    deadline - (startsAt ? Date.parse(startsAt) : Date.now()) > 30 * 60000 ||
    !prerequisite?.startsWith(market.toLowerCase() + '-') ||
    (startsAt &&
      (!Number.isFinite(Date.parse(startsAt)) ||
        Date.parse(startsAt) >= deadline ||
        Date.parse(startsAt) - Date.now() > 36 * 3600000)) ||
    (market === 'US' && !startsAt)
  )
    throw new Error('PAPER_PREFLIGHT_FAILED');
  if (!/^[a-f0-9]{64}$/.test(expectedBuild ?? '') || (await fingerprint()) !== expectedBuild)
    throw new Error('PAPER_BUILD_CHANGED');
  try {
    const expectedHash = values['expectations-hash'];
    if (!values.expectations || !/^[a-f0-9]{64}$/.test(expectedHash ?? '')) throw new Error('PAPER_CONTROL_CHANGED');
    const text = await readFile(values.expectations, 'utf8');
    if (Buffer.byteLength(text) > 65536) throw new Error('PAPER_CONTROL_CHANGED');
    const { contentHash } = await load('packages/database/dist/index.js');
    const expectations = JSON.parse(text);
    const selected = expectations[market];
    if (
      contentHash(expectations) !== expectedHash ||
      !selected ||
      !Number.isSafeInteger(selected.version) ||
      selected.version < 0 ||
      !Number.isSafeInteger(selected.epoch) ||
      selected.epoch < 0 ||
      ['entryHash', 'limitsHash', 'strategyHash'].some((key) => !/^[a-f0-9]{64}$/.test(selected[key] ?? ''))
    )
      throw new Error('PAPER_CONTROL_CHANGED');
  } catch {
    throw new Error('PAPER_CONTROL_CHANGED');
  }
  const { createObservationJobs } = await load('apps/api/dist/observation-jobs.js');
  const { createObservationReports } = await load('apps/api/dist/observation-reports.js');
  const { writeReviewArtifact } = await load('apps/worker/dist/paper-review-files.js');
  const runRoot = resolve(root, '.local-data/paper-validation-runs');
  await mkdir(runRoot, { recursive: true, mode: 0o700 });
  const directory = resolve(runRoot, values['run-id'] ?? randomUUID());
  await mkdir(directory, { mode: 0o700 });
  const emit = (value) =>
    console.log(JSON.stringify({ service: 'authorized-paper-validation', market, ...value, executionEnabled: false }));
  const control = new AbortController();
  const deadlineTimeout = setTimeout(() => control.abort(), Math.max(1, deadline - Date.now()));
  const stop = () => control.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let db,
    brokerDb,
    entry,
    beforeRun,
    afterRun,
    phase = 'waiting',
    runStarted = false;
  let result = { state: 'incomplete', resumeRequested: true, maxTicks: 60, completedTicks: 0 };
  try {
    await writeReviewArtifact(resolve(directory, 'request.json'), {
      formatVersion: 'authorized-paper-validation-v1',
      market,
      prerequisite,
      startsAt,
      deadline: new Date(deadline).toISOString(),
      resumeRequested: true,
      maxTicks: 60,
      buildHash: expectedBuild,
      resourcesHash: resource.resourcesHash,
      expectedControlHash: values['expectations-hash'] ?? null,
      automaticRetry: false,
      executionEnabled: false,
    });
    // Preserve the validated request before the second, race-sensitive build check.
    // A build change here must leave a linked failure rather than only a result file.
    if (!/^[a-f0-9]{64}$/.test(expectedBuild ?? '') || (await fingerprint()) !== expectedBuild)
      throw new Error('PAPER_BUILD_CHANGED');
    emit({ state: 'waiting-for-prerequisite', startsAt, prerequisite });
    const jobs = createObservationJobs(resolve(root, '.local-data/scheduled-observations'));
    const reports = createObservationReports(
      resolve(root, '.local-data/observations'),
      resolve(root, '.local-data/scheduled-observations'),
    );
    while (true) {
      control.signal.throwIfAborted();
      if (Date.now() >= deadline) throw new Error('PREREQUISITE_UNVERIFIED');
      if (startsAt && Date.now() < Date.parse(startsAt)) {
        await delay(Math.min(15000, Date.parse(startsAt) - Date.now()), undefined, { signal: control.signal });
        continue;
      }
      if (startsAt && Date.now() - Date.parse(startsAt) > 120000) throw new Error('START_MISSED');
      const list = await jobs.list();
      const job = list.jobs.find((x) => x.id === prerequisite);
      if (job && ['failed', 'cancelled'].includes(job.state)) throw new Error('PREREQUISITE_FAILED');
      if (job?.state === 'completed' && job.reportId) {
        const report = await reports.get(job.reportId);
        if (
          report.monitoring.evidence !== 'final-hash-verified' ||
          report.monitoring.state !== 'terminal' ||
          report.manifest.source !== 'toss-readonly' ||
          report.manifest.instruments.length !== 1 ||
          report.manifest.instruments[0].market !== market ||
          report.recordedSamples !== 60 ||
          report.summary?.healthy !== 60 ||
          report.summary?.errorSamples !== 0 ||
          report.summary?.blocked !== 0 ||
          report.monitoring.gapCount !== 0
        )
          throw new Error('PREREQUISITE_FAILED');
        await writeReviewArtifact(resolve(directory, 'observation-evidence.json'), {
          job: prerequisite,
          reportId: report.manifest.id,
          journalSha256: report.journalSha256,
          monitoring: report.monitoring,
          summary: report.summary,
          executionEnabled: false,
        });
        break;
      }
      await delay(15000, undefined, { signal: control.signal });
    }
    if ((await fingerprint()) !== expectedBuild) throw new Error('PAPER_BUILD_CHANGED');
    await verifyPaperValidationResources(resourceDirectory, resourcesHash, market);
    const { createDatabase, contentHash } = await load('packages/database/dist/index.js');
    const { assertDedicatedPaperDatabase } = await load('packages/database/dist/test-database.js');
    const { createTossReadonlyBroker } = await load('packages/broker/dist/toss/index.js');
    const { planPaperDayReview, applyPaperDayReview } = await load('apps/worker/dist/paper-day-review.js');
    const { paperReviewCheckpoint, reviewPaperCheckpoints } = await load('apps/worker/dist/paper-review.js');
    const { parsePaperMarketConfig } = await load('apps/worker/dist/paper-market-config.js');
    const { runPaperMarket } = await load('apps/worker/dist/paper-market-runtime.js');
    const { createPaperWorker } = await load('apps/worker/dist/paper-worker.js');
    const { paperSessionState, prepareStrategyData } = await load('packages/trading/dist/index.js');
    const environment = {
      ...parseEnv(await readFile('.env', 'utf8')),
      ...parseEnv(await readFile('.local-data/paper-market-local/.env', 'utf8')),
    };
    if (environment.TRADING_MODE !== 'paper') throw new Error('PAPER_PREFLIGHT_FAILED');
    const accounts = JSON.parse(await readFile('.local-data/paper-market-local/accounts.json', 'utf8'));
    entry = accounts.entries.find((x) => x.market === market.toLowerCase());
    const expectedFile = values.expectations;
    const expectedHash = values['expectations-hash'];
    if (!expectedFile || !/^[a-f0-9]{64}$/.test(expectedHash ?? '')) throw new Error('PAPER_CONTROL_CHANGED');
    const expectations = JSON.parse(await readFile(expectedFile, 'utf8'));
    if (contentHash(expectations) !== expectedHash) throw new Error('PAPER_CONTROL_CHANGED');
    const expected = expectations[market];
    if (!expected || !entry || contentHash(entry) !== expected.entryHash) throw new Error('PAPER_CONTROL_CHANGED');
    if (!entry || !/^paper-market-[A-Za-z0-9._:-]{1,70}$/.test(entry.accountId))
      throw new Error('PAPER_PREFLIGHT_FAILED');
    db = createDatabase(environment.PAPER_MARKET_DATABASE_URL);
    brokerDb = createDatabase(environment.DATABASE_URL);
    await assertDedicatedPaperDatabase(db, environment.PAPER_MARKET_DATABASE_URL);
    const capture = async (name) => {
      const cp = paperReviewCheckpoint(await db.paperReview.capture(entry.accountId, 'toss-readonly'));
      await writeReviewArtifact(resolve(directory, name + '.json'), cp);
      return cp;
    };
    const clean = (s) =>
      s.stopped &&
      !s.leasePresent &&
      !s.reservations.some((x) => x.active) &&
      !s.intents.some((x) => ['INTENT_RECORDED', 'READY', 'PARTIALLY_FILLED'].includes(x.state));
    phase = 'account-preflight';
    emit({ state: phase });
    if (entry.planHash !== resource.planHash) throw new Error('PAPER_MARKET_PLAN_HASH_MISMATCH');
    const prep = await checkPaperValidationPreparation(
      { directory: resourceDirectory, resourcesHash, market, accountId: entry.accountId },
      environment,
    );
    const required = [
      'paperSource',
      'stopped',
      'noLease',
      'limitsMatch',
      'initialCash',
      'emptyPositions',
      'noOrders',
      'noFills',
      'noReservations',
      'strategyMatches',
      'historyMatches',
      'preparationReceipt',
    ];
    if (required.some((x) => prep.checks[x] !== true)) throw new Error('PAPER_ACCOUNT_NOT_PRISTINE');
    const initial = await capture('preparation-before');
    if (!clean(initial.snapshot)) throw new Error('PAPER_ACCOUNT_NOT_PRISTINE');
    if (
      initial.snapshot.version !== expected.version ||
      initial.snapshot.epoch !== expected.epoch ||
      initial.snapshot.limitsHash !== expected.limitsHash ||
      initial.snapshot.strategyHash !== expected.strategyHash
    )
      throw new Error('PAPER_CONTROL_CHANGED');
    phase = 'daily-review';
    emit({ state: phase });
    let dayApplied = false;
    try {
      const plan = await planPaperDayReview(db.paper, entry.accountId);
      if (plan.expectedVersion !== initial.snapshot.version) throw new Error('PAPER_CONTROL_CHANGED');
      if (plan.policy !== 'carry-negative-pnl-v1' || plan.source !== 'toss-readonly')
        throw new Error('PAPER_PREFLIGHT_FAILED');
      await writeReviewArtifact(resolve(directory, 'day-review-plan.json'), plan);
      await applyPaperDayReview(
        {
          paper: db.paper,
          clientId: environment.TOSS_CLIENT_ID,
          withBrokerLease: (key, operation) => brokerDb.withBrokerLease(key, operation),
          createBroker: (signal) =>
            createTossReadonlyBroker({
              clientId: environment.TOSS_CLIENT_ID,
              clientSecret: environment.TOSS_CLIENT_SECRET,
              signal,
            }),
        },
        plan,
        'CARRY_FORWARD_PAPER_LOSSES',
        control.signal,
      );
      dayApplied = true;
    } catch (error) {
      if (!(error instanceof Error && error.message === 'PAPER_TRADING_DAY_REVIEW_NOT_REQUIRED')) throw error;
    }
    const reviewed = await capture('day-review-after');
    verifyDailyControl(initial.snapshot, reviewed.snapshot, dayApplied);
    const economics = (s) => ({
      cash: s.cash,
      positions: s.positions,
      basis: s.basis,
      intents: s.intents,
      fills: s.fills,
      reservations: s.reservations,
    });
    if (
      !clean(reviewed.snapshot) ||
      contentHash(economics(initial.snapshot)) !== contentHash(economics(reviewed.snapshot))
    )
      throw new Error('PAPER_PREFLIGHT_FAILED');
    const stored = await db.paper.readStrategies(entry.accountId);
    const instruments = stored.map((x) => x.definition.instrument);
    let lastFrames;
    const statuses = [];
    const runPhase = async (resume, ticks) => {
      const config = parsePaperMarketConfig(
        [`--account=${entry.accountId}`, `--ticks=${ticks}`, ...(resume ? ['--resume'] : [])],
        environment,
      );
      if (config.resume !== resume || config.prepare || config.initialize || config.stop || ticks > 60)
        throw new Error('PAPER_PREFLIGHT_FAILED');
      await runPaperMarket(
        config,
        {
          paper: db.paper,
          prepare: async () => {
            throw new Error('PAPER_PREFLIGHT_FAILED');
          },
          withBrokerLease: (key, operation) => brokerDb.withBrokerLease(key, operation),
          createBroker: createTossReadonlyBroker,
          createWorker: (value, source) =>
            createPaperWorker(
              {
                ...db.paper,
                acquireLease: (id, ttl, dataSource) =>
                  db.paper.acquireLease(
                    id,
                    ttl,
                    dataSource,
                    resume ? beforeRun.snapshot.version : reviewed.snapshot.version,
                  ),
              },
              value,
              async (instruments, signal) => {
                const frames = await source(instruments, signal);
                lastFrames = frames;
                return frames;
              },
            ),
        },
        AbortSignal.any([control.signal, AbortSignal.timeout(resume ? 900000 : 60000)]),
        (status) => {
          statuses.push(status);
          emit({ state: resume ? 'paper-tick' : 'stopped-observation', tick: statuses.length, ...status });
        },
      );
    };
    phase = 'stopped-observation';
    emit({ state: phase });
    await runPhase(false, 1);
    const observed = await capture('stopped-observation-after');
    verifyStoppedControl(reviewed.snapshot, observed.snapshot);
    const current = await db.paper.readAccount(entry.accountId);
    if (current.snapshot.version !== observed.snapshot.version || current.control.epoch !== observed.snapshot.epoch)
      throw new Error('PAPER_CONTROL_CHANGED');
    const session = paperSessionState(lastFrames, instruments, current.asOf);
    const prepared = lastFrames.map((frame) =>
      prepareStrategyData({
        ...frame.marketData,
        instrument: frame.quote.instrument,
        quoteTimestamp: frame.quote.timestamp,
        quoteObservedAt: frame.quote.observedAt,
        accountObservedAt: current.snapshot.observedAt,
        accountAvailable: current.snapshot.reconciled,
        asOf: current.asOf,
      }),
    );
    await writeReviewArtifact(resolve(directory, 'preflight-evidence.json'), {
      session,
      ready: prepared.map((x) => ({
        ready: x.ready,
        blockers: x.blockers,
        closedCandles: x.candles.length,
        validUntil: x.validUntil,
      })),
      stoppedAndCleaned: clean(observed.snapshot),
      executionEnabled: false,
    });
    if (
      !clean(observed.snapshot) ||
      prepared.some(
        (x) => !x.ready || x.candles.length < Math.max(...stored.map((s) => s.definition.parameters.slowPeriod)) + 1,
      ) ||
      statuses.length !== 1 ||
      statuses[0].state !== 'paused'
    )
      throw new Error('PAPER_PREFLIGHT_FAILED');
    if (
      observed.snapshot.limitsHash !== initial.snapshot.limitsHash ||
      observed.snapshot.strategyHash !== initial.snapshot.strategyHash
    )
      throw new Error('PAPER_CONFIGURATION_CHANGED');
    if ((await fingerprint()) !== expectedBuild) throw new Error('PAPER_BUILD_CHANGED');
    await verifyPaperValidationResources(resourceDirectory, resourcesHash, market);
    beforeRun = await capture('before');
    if (
      beforeRun.snapshot.version !== observed.snapshot.version ||
      beforeRun.snapshot.epoch !== observed.snapshot.epoch
    )
      throw new Error('PAPER_CONTROL_CHANGED');
    statuses.length = 0;
    phase = 'authorized-paper-run';
    runStarted = true;
    emit({ state: phase, maxTicks: 60 });
    await runPhase(true, 60).finally(async () => {
      afterRun = await capture('after');
      const report = reviewPaperCheckpoints(beforeRun, afterRun, new Date().toISOString());
      await writeReviewArtifact(resolve(directory, 'review.json'), {
        formatVersion: 'paper-review-artifact-v1',
        report,
        hash: contentHash(report),
      });
      result = {
        state:
          report.verdict === 'issues-found'
            ? 'review-issues-found'
            : report.verdict === 'incomplete'
              ? 'completed-with-incomplete-review'
              : 'completed',
        resumeRequested: true,
        maxTicks: 60,
        completedTicks: statuses.length,
        runningTicks: statuses.filter((x) => x.state === 'running').length,
        verdict: report.verdict,
        stoppedAndCleaned: clean(afterRun.snapshot),
        intents: afterRun.snapshot.intents.length,
        fills: afterRun.snapshot.fills.length,
      };
      if (result.completedTicks !== 60 || result.runningTicks !== 60) result.state = 'execution-ended-early';
      if (!clean(afterRun.snapshot)) throw new Error('PAPER_CLEANUP_INCOMPLETE');
    });
  } catch (error) {
    const code = paperValidationFailureCode(error, control.signal.aborted);
    result = { ...result, state: 'stopped-before-run-or-failed', phase, code, runStarted };
    if (db && entry)
      try {
        const { paperReviewCheckpoint } = await load('apps/worker/dist/paper-review.js');
        const checkpoint = paperReviewCheckpoint(await db.paperReview.capture(entry.accountId, 'toss-readonly'));
        await writeReviewArtifact(resolve(directory, 'failure-after.json'), checkpoint);
        result.stoppedAndCleaned =
          checkpoint.snapshot.stopped &&
          !checkpoint.snapshot.leasePresent &&
          !checkpoint.snapshot.reservations.some((x) => x.active) &&
          !checkpoint.snapshot.intents.some((x) => ['INTENT_RECORDED', 'READY', 'PARTIALLY_FILLED'].includes(x.state));
      } catch {
        result.stoppedAndCleaned = null;
      }
  } finally {
    clearTimeout(deadlineTimeout);
    await Promise.allSettled([db?.close(), brokerDb?.close()]);
    await writeReviewArtifact(resolve(directory, 'result.json'), {
      formatVersion: 'authorized-paper-validation-result-v1',
      market,
      ...result,
      finishedAt: new Date().toISOString(),
      executionEnabled: false,
      automaticRetry: false,
    });
    if (['completed-with-incomplete-review', 'execution-ended-early'].includes(result.state)) process.exitCode = 2;
    else if (result.state !== 'completed') process.exitCode = 1;
    emit(result);
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
await main().catch((error) => {
  const code =
    error instanceof Error &&
    [
      'PAPER_MARKET_PLAN_INVALID',
      'PAPER_MARKET_PLAN_HASH_MISMATCH',
      'PAPER_VALIDATION_RESOURCE_INVALID',
      'PAPER_PREFLIGHT_FAILED',
      'PAPER_BUILD_CHANGED',
      'PAPER_CONTROL_CHANGED',
    ].includes(error.message)
      ? error.message
      : 'PAPER_VALIDATION_NOT_COMPLETED';
  console.error(JSON.stringify({ service: 'authorized-paper-validation', code, executionEnabled: false }));
  process.exitCode = 1;
});
