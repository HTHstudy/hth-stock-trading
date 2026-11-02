import { Decimal } from 'decimal.js';
import { paperReviewCheckpointSchema, paperReviewReportSchema } from '@hth/contracts';
import type { PaperReviewSnapshot, PaperReviewReport, PaperReviewCheckpoint } from '@hth/contracts';
import { contentHash } from '@hth/database';

const Money = Decimal.clone({ precision: 200 });
const instrument = (i: { market: string; symbol: string }) => `${i.market}:${i.symbol}`;
const basisKey = (i: { market: string; symbol: string }, strategy: string) => `${instrument(i)}:${strategy}`;
const unit = (i: { market: string }) => (i.market === 'KR' ? '1' : '0.01');
const unique = (values: string[]) => new Set(values).size === values.length;
const sum = (values: string[]) => values.reduce((total, v) => total.plus(v), new Money(0));
const eq = (a: string, b: string) => new Money(a).eq(b);
const microtime = (instant: string) =>
  BigInt(Date.parse(instant)) * 1000n + BigInt((instant.match(/\.(\d+)/)?.[1] ?? '').padEnd(6, '0').slice(3, 6));

export function paperReviewCheckpoint(snapshot: PaperReviewSnapshot): PaperReviewCheckpoint {
  const parsed = paperReviewCheckpointSchema.shape.snapshot.parse(snapshot);
  return paperReviewCheckpointSchema.parse({
    formatVersion: 'paper-review-checkpoint-v1',
    snapshot: parsed,
    hash: contentHash(parsed),
  });
}
function verified(value: unknown) {
  const parsed = paperReviewCheckpointSchema.safeParse(value);
  return parsed.success && parsed.data.hash === contentHash(parsed.data.snapshot) ? parsed.data : null;
}
function integrity(s: PaperReviewSnapshot) {
  const orders = new Map(s.intents.map((i) => [i.key, i]));
  const ownership = new Map<string, string>();
  let valid =
    unique(s.intents.map((i) => i.key)) &&
    unique(s.intents.map((i) => i.dedupeKey)) &&
    unique(s.fills.map((f) => f.key)) &&
    unique(s.events.map((e) => e.key)) &&
    unique(s.reservations.map((r) => r.intentKey)) &&
    unique(s.positions.map((p) => instrument(p.instrument))) &&
    unique(s.basis.map((b) => basisKey(b.instrument, b.strategyKey))) &&
    [...s.fills, ...s.events].every((e) => microtime(e.createdAt) <= microtime(s.asOf));
  valid &&= new Money(s.cash.KRW).mod(1).eq(0) && new Money(s.cash.USD).mod('0.01').eq(0);
  for (const p of s.positions) {
    valid &&=
      unique(p.ownership.map((o) => o.strategyKey)) &&
      sum([p.manualQuantity, ...p.ownership.map((o) => o.quantity)]).eq(p.quantity) &&
      new Money(p.sellableQuantity).lte(p.quantity);
    for (const o of p.ownership) ownership.set(basisKey(p.instrument, o.strategyKey), o.quantity);
  }
  for (const b of s.basis) {
    valid &&=
      eq(b.quantity, ownership.get(basisKey(b.instrument, b.strategyKey)) ?? '0') &&
      new Money(b.amount).mod(unit(b.instrument)).eq(0) &&
      (!new Money(b.quantity).isZero() || new Money(b.amount).isZero());
    ownership.delete(basisKey(b.instrument, b.strategyKey));
  }
  valid &&= [...ownership.values()].every((q) => eq(q, '0'));
  for (const f of s.fills) {
    const order = orders.get(f.intentKey);
    if (!order) {
      valid = false;
      continue;
    }
    valid &&=
      f.requestVerified &&
      new Money(f.quantity).gt(0) &&
      new Money(f.price).gt(0) &&
      new Money(f.quantity).mul(f.price).eq(f.notional) &&
      [f.price, f.notional, f.costs, f.realizedPnl].every((n) => new Money(n).mod(unit(order.instrument)).eq(0));
  }
  for (const i of s.intents) {
    const fills = s.fills.filter((f) => f.intentKey === i.key);
    const q = new Money(i.filledQuantity),
      total = new Money(i.quantity);
    valid &&=
      i.requestVerified &&
      i.dedupeVerified &&
      total.gt(0) &&
      q.lte(total) &&
      sum(fills.map((f) => f.quantity)).eq(q) &&
      sum(fills.map((f) => f.notional)).eq(i.filledNotional) &&
      sum(fills.map((f) => f.costs)).eq(i.paidCosts);
    valid &&=
      i.state === 'FILLED'
        ? q.eq(total)
        : i.state === 'PARTIALLY_FILLED'
          ? q.gt(0) && q.lt(total)
          : ['INTENT_RECORDED', 'READY', 'RISK_REJECTED'].includes(i.state)
            ? q.isZero()
            : true;
  }
  for (const r of s.reservations) {
    const i = orders.get(r.intentKey);
    if (!i) {
      valid = false;
      continue;
    }
    if (r.active)
      valid &&=
        ['READY', 'PARTIALLY_FILLED'].includes(i.state) &&
        new Money(i.quantity).minus(i.filledQuantity).eq(r.quantity) &&
        new Money(r.quantity).gt(0) &&
        (i.side === 'BUY' ? eq(r.sellQuantity, '0') : eq(r.cashAmount, '0') && eq(r.sellQuantity, r.quantity));
  }
  return valid;
}
function preserved<T extends { key: string }>(before: T[], after: T[]) {
  const map = new Map(after.map((item) => [item.key, item]));
  return before.every((item) => map.has(item.key) && contentHash(item) === contentHash(map.get(item.key)));
}

export function reviewPaperCheckpoints(beforeInput: unknown, afterInput: unknown, asOf: string): PaperReviewReport {
  const before = verified(beforeInput),
    after = verified(afterInput);
  const limitations: PaperReviewReport['limitations'] = [
    'CHECKPOINT_INTERVAL_ONLY',
    'NO_MARKET_DATA_REVALIDATION',
    'NO_EQUITY_OR_DAILY_PNL_REVALIDATION',
    'NO_PROFITABILITY_CLAIM',
    'NO_TRADING_AUTHORIZATION',
  ];
  const report: PaperReviewReport = {
    formatVersion: 'paper-review-report-v1',
    asOf,
    scope: before?.snapshot.scope ?? null,
    source: before?.snapshot.source ?? null,
    beforeHash: before?.hash ?? null,
    afterHash: after?.hash ?? null,
    verdict: 'incomplete',
    executionEnabled: false,
    canResume: false,
    checks: { checkpoints: 'unverified' },
    evidence: null,
    comparison: null,
    limitations,
  };
  const finish = () => paperReviewReportSchema.parse(report);
  if (!before || !after) {
    if (beforeInput == null || afterInput == null) limitations.push('MISSING_CHECKPOINT');
    if ((beforeInput != null && !before) || (afterInput != null && !after)) limitations.push('INVALID_CHECKPOINT');
    return finish();
  }
  const a = before.snapshot,
    b = after.snapshot;
  report.checks.checkpoints = 'passed';
  if (
    a.scope !== b.scope ||
    a.source !== b.source ||
    microtime(a.asOf) > microtime(b.asOf) ||
    a.version > b.version ||
    a.epoch > b.epoch
  ) {
    report.checks.comparable = 'failed';
    report.verdict = 'issues-found';
    limitations.push('INCOMPARABLE_CHECKPOINTS');
    return finish();
  }
  const check = (name: string, value: boolean) => {
    report.checks[name] = value ? 'passed' : 'failed';
  };
  check('comparable', true);
  check('beforeIntegrity', integrity(a));
  check('afterIntegrity', integrity(b));
  if (report.checks.beforeIntegrity === 'failed' || report.checks.afterIntegrity === 'failed') {
    report.verdict = 'issues-found';
    return finish();
  }
  const oldFills = new Set(a.fills.map((f) => f.key)),
    oldEvents = new Set(a.events.map((e) => e.key)),
    oldOrders = new Set(a.intents.map((i) => i.key));
  const fills = b.fills.filter((f) => !oldFills.has(f.key));
  const events = b.events.filter((e) => !oldEvents.has(e.key));
  const orders = new Map(b.intents.map((i) => [i.key, i]));
  report.checks.intervalEvidence = [...fills, ...events].every((e) => microtime(e.createdAt) > microtime(a.asOf))
    ? 'passed'
    : 'unverified';
  if (report.checks.intervalEvidence === 'unverified') limitations.push('AMBIGUOUS_INTERVAL');
  check('priorFillsPreserved', preserved(a.fills, b.fills));
  check('priorEventsPreserved', preserved(a.events, b.events));
  const identity = (i: PaperReviewSnapshot['intents'][number]) => ({
    key: i.key,
    dedupeKey: i.dedupeKey,
    requestHash: i.requestHash,
    strategyKey: i.strategyKey,
    instrument: i.instrument,
    side: i.side,
    quantity: i.quantity,
  });
  check(
    'priorIntentsPreserved',
    a.intents.every((i) => {
      const next = orders.get(i.key);
      return (
        next &&
        contentHash(identity(i)) === contentHash(identity(next)) &&
        new Money(next.filledQuantity).gte(i.filledQuantity) &&
        new Money(next.filledNotional).gte(i.filledNotional) &&
        new Money(next.paidCosts).gte(i.paidCosts) &&
        (!['FILLED', 'RISK_REJECTED', 'ABORTED'].includes(i.state) || next.state === i.state)
      );
    }),
  );
  check('configurationStable', a.limitsHash === b.limitsHash && a.strategyHash === b.strategyHash);
  check('stopped', b.stopped);
  check('leaseReleased', !b.leasePresent);
  check(
    'noOpenIntents',
    b.intents.every((i) => !['INTENT_RECORDED', 'READY', 'PARTIALLY_FILLED'].includes(i.state)),
  );
  check(
    'noActiveReservations',
    b.reservations.every((r) => !r.active),
  );
  report.checks.stoppedBaseline = a.stopped && !a.leasePresent ? 'passed' : 'unverified';
  const count = (kind: string) => events.filter((e) => e.kind === kind).length;
  report.evidence = {
    newIntents: b.intents.filter((i) => !oldOrders.has(i.key)).length,
    newFills: fills.length,
    newObservations: count('ACCOUNT_OBSERVED'),
    newDiagnostics: count('STRATEGY_DIAGNOSED'),
    leaseAcquisitions: count('LEASE_ACQUIRED'),
    leaseReleases: count('LEASE_RELEASED'),
  };
  report.checks.workerCycle =
    report.evidence.leaseAcquisitions === 1 &&
    report.evidence.leaseReleases === 1 &&
    report.evidence.newObservations > 0
      ? 'passed'
      : 'unverified';
  if (report.evidence.leaseAcquisitions > 1 || report.evidence.leaseReleases > 1)
    limitations.push('MULTIPLE_LEASE_CYCLES');
  report.checks.intentPath = report.evidence.newIntents > 0 ? 'passed' : 'unverified';
  report.checks.diagnosticsRecorded = report.evidence.newDiagnostics > 0 ? 'passed' : 'unverified';
  report.checks.fillPath = fills.length > 0 ? 'passed' : 'unverified';
  if (!fills.length || !report.evidence.newIntents) limitations.push('NO_INTENT_OR_FILL');
  const unsupported = events.some((e) =>
    [
      'ACCOUNT_CREATED',
      'ACCOUNT_RECONCILED',
      'LIMITS_CHANGED',
      'STRATEGY_CHANGED',
      'DAILY_REVIEW_COMPLETED',
      'OTHER',
    ].includes(e.kind),
  );
  report.checks.externalChanges = unsupported ? 'unverified' : 'passed';
  if (unsupported) limitations.push('UNSUPPORTED_LEDGER_CHANGE');
  const cash = { KRW: new Money(a.cash.KRW), USD: new Money(a.cash.USD) },
    costs = { KRW: new Money(0), USD: new Money(0) },
    realized = { KRW: new Money(0), USD: new Money(0) };
  const holdings = new Map<string, Decimal>(),
    manual = new Map<string, string>(),
    owned = new Map<string, Decimal>();
  for (const p of a.positions) {
    holdings.set(instrument(p.instrument), new Money(p.quantity));
    manual.set(instrument(p.instrument), p.manualQuantity);
    for (const o of p.ownership) owned.set(basisKey(p.instrument, o.strategyKey), new Money(o.quantity));
  }
  for (const f of fills) {
    const i = orders.get(f.intentKey)!;
    const currency = i.instrument.market === 'KR' ? 'KRW' : 'USD',
      direction = i.side === 'BUY' ? 1 : -1;
    cash[currency] = cash[currency].plus(new Money(f.notional).mul(-direction)).minus(f.costs);
    costs[currency] = costs[currency].plus(f.costs);
    realized[currency] = realized[currency].plus(f.realizedPnl);
    const k = instrument(i.instrument),
      o = basisKey(i.instrument, i.strategyKey);
    holdings.set(k, (holdings.get(k) ?? new Money(0)).plus(new Money(f.quantity).mul(direction)));
    owned.set(o, (owned.get(o) ?? new Money(0)).plus(new Money(f.quantity).mul(direction)));
  }
  const sameQuantities = (expected: Map<string, Decimal>, actual: Map<string, string>) =>
    [...new Set([...expected.keys(), ...actual.keys()])].every((k) =>
      (expected.get(k) ?? new Money(0)).eq(actual.get(k) ?? '0'),
    );
  const afterHoldings = new Map(b.positions.map((p) => [instrument(p.instrument), p.quantity])),
    afterManual = new Map(b.positions.map((p) => [instrument(p.instrument), p.manualQuantity]));
  const afterOwned = new Map(
    b.positions.flatMap((p) => p.ownership.map((o) => [basisKey(p.instrument, o.strategyKey), o.quantity] as const)),
  );
  check('cashMatchesFills', cash.KRW.eq(b.cash.KRW) && cash.USD.eq(b.cash.USD));
  check('positionsMatchFills', sameQuantities(holdings, afterHoldings));
  check('ownershipMatchesFills', sameQuantities(owned, afterOwned));
  check(
    'manualHoldingsPreserved',
    [...new Set([...manual.keys(), ...afterManual.keys()])].every((k) =>
      eq(manual.get(k) ?? '0', afterManual.get(k) ?? '0'),
    ),
  );
  const chronological = [...fills].sort((l, r) =>
    microtime(l.createdAt) < microtime(r.createdAt) ? -1 : microtime(l.createdAt) > microtime(r.createdAt) ? 1 : 0,
  );
  const ties = new Set<string>();
  let ambiguous = false;
  for (const f of chronological) {
    const i = orders.get(f.intentKey)!;
    const k = basisKey(i.instrument, i.strategyKey) + ':' + microtime(f.createdAt);
    if (ties.has(k)) ambiguous = true;
    ties.add(k);
  }
  if (ambiguous) {
    report.checks.costBasisReplay = 'unverified';
    limitations.push('AMBIGUOUS_FILL_ORDER');
  } else {
    const bases = new Map(
      a.basis.map((v) => [
        basisKey(v.instrument, v.strategyKey),
        { quantity: new Money(v.quantity), amount: new Money(v.amount) },
      ]),
    );
    let valid = true;
    for (const f of chronological) {
      const i = orders.get(f.intentKey)!,
        k = basisKey(i.instrument, i.strategyKey),
        previous = bases.get(k) ?? { quantity: new Money(0), amount: new Money(0) },
        q = new Money(f.quantity);
      if (i.side === 'BUY') {
        previous.quantity = previous.quantity.plus(q);
        previous.amount = previous.amount.plus(f.notional).plus(f.costs);
        valid &&= eq(f.realizedPnl, '0');
      } else if (q.gt(previous.quantity) || previous.quantity.isZero()) {
        valid = false;
        continue;
      } else {
        const removed = q.eq(previous.quantity)
          ? previous.amount
          : previous.amount.mul(q).div(previous.quantity).div(unit(i.instrument)).floor().mul(unit(i.instrument));
        valid &&= new Money(f.notional).minus(f.costs).minus(removed).eq(f.realizedPnl);
        previous.quantity = previous.quantity.minus(q);
        previous.amount = previous.amount.minus(removed);
      }
      bases.set(k, previous);
    }
    const actual = new Map(b.basis.map((v) => [basisKey(v.instrument, v.strategyKey), v]));
    valid &&= [...new Set([...bases.keys(), ...actual.keys()])].every(
      (k) =>
        (bases.get(k)?.quantity ?? new Money(0)).eq(actual.get(k)?.quantity ?? '0') &&
        (bases.get(k)?.amount ?? new Money(0)).eq(actual.get(k)?.amount ?? '0'),
    );
    check('costBasisReplay', valid);
  }
  report.comparison = {
    cashBefore: a.cash,
    cashAfter: b.cash,
    dailyPnlBefore: a.dailyPnl,
    dailyPnlAfter: b.dailyPnl,
    costs: { KRW: costs.KRW.toFixed(), USD: costs.USD.toFixed() },
    realizedPnl: { KRW: realized.KRW.toFixed(), USD: realized.USD.toFixed() },
    basisBefore: a.basis,
    basisAfter: b.basis,
  };
  report.verdict = Object.values(report.checks).includes('failed')
    ? 'issues-found'
    : Object.values(report.checks).includes('unverified')
      ? 'incomplete'
      : 'consistent-observed-state';
  return finish();
}
