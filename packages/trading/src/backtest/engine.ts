import { Decimal } from 'decimal.js';
import { backtestConfigSchema, historicalDatasetSchema, strategySignalSchema } from '@hth/contracts';
import type { BacktestConfig, HistoricalDataset } from '@hth/contracts';
import { buildHistoricalDataset } from '../market-data/historical.js';
import type { Strategy } from '../strategy/types.js';

const Money = Decimal.clone({ precision: 100, rounding: Decimal.ROUND_HALF_UP });
function freeze(value: unknown): void {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(freeze);
  }
}
type SignalStatus =
  | 'HOLD'
  | 'PENDING'
  | 'FILLED'
  | 'INSUFFICIENT_CASH'
  | 'INVALID_PRICE'
  | 'ALREADY_LONG'
  | 'NO_POSITION'
  | 'SUPERSEDED'
  | 'PENDING_EXISTS'
  | 'UNFILLED_END';
export interface BacktestSignal {
  barTimestamp: string;
  evaluatedAt: string;
  action: 'BUY' | 'SELL' | 'HOLD';
  reason: string;
  status: SignalStatus;
}
export interface BacktestFill {
  signalIndex: number;
  action: 'BUY' | 'SELL';
  timestamp: string;
  barTimestamp: string;
  referencePrice: string;
  price: string;
  quantity: string;
  notional: string;
  fee: string;
  tax: string;
  cashAfter: string;
}
export interface EquityPoint {
  timestamp: string;
  kind: 'initial' | 'open' | 'close';
  equity: string;
  cash: string;
  quantity: string;
  cumulativeReturnPct: string;
}
export interface ClosedTrade {
  entryFill: number;
  exitFill: number;
  netPnl: string;
}
export interface BacktestReport<Config = unknown> {
  formatVersion: 'backtest-report-v1';
  engineVersion: '1.0.0';
  mode: 'paper';
  executionEnabled: false;
  model: 'next-eligible-open-v1';
  strategy: { id: string; version: string; parameters: Config };
  config: BacktestConfig;
  currency: 'KRW' | 'USD';
  datasetRequest: HistoricalDataset['request'];
  pointInTime: false;
  warnings: string[];
  signals: BacktestSignal[];
  fills: BacktestFill[];
  trades: ClosedTrade[];
  equity: EquityPoint[];
  metrics: {
    initialCash: string;
    endingCash: string;
    endingQuantity: string;
    endingEquity: string;
    netPnl: string;
    realizedPnl: string;
    unrealizedPnl: string;
    cumulativeReturnPct: string;
    maxDrawdownPct: string;
    winRatePct: string | null;
    tradeCount: number;
    fillCount: number;
    totalFees: string;
    totalTax: string;
  };
}

export function runBacktest<Config>(input: {
  dataset: HistoricalDataset;
  strategy: Strategy<Config>;
  strategyConfig: Config;
  config: BacktestConfig;
}): BacktestReport<Config> {
  const parsed = historicalDatasetSchema.safeParse(input.dataset);
  if (!parsed.success || !parsed.data.coverage.complete) throw new Error('INVALID_BACKTEST_DATASET');
  const dataset = buildHistoricalDataset({
    request: parsed.data.request,
    instrument: parsed.data.instrument,
    calendars: parsed.data.calendars,
    observations: parsed.data.observations,
    startedAt: parsed.data.startedAt,
    completedAt: parsed.data.completedAt,
  });
  if (JSON.stringify(parsed.data) !== JSON.stringify(dataset)) throw new Error('BACKTEST_DATASET_PROOF_MISMATCH');
  const configResult = backtestConfigSchema.safeParse(input.config);
  if (!configResult.success) throw new Error('INVALID_BACKTEST_CONFIG');
  const config = configResult.data;
  const parameters = structuredClone(input.strategyConfig);
  freeze(parameters);
  if (new Money(config.sellFeeBps).plus(config.sellTaxBps).gte(10_000)) throw new Error('INVALID_BACKTEST_CONFIG');
  if (!input.strategy.id || !input.strategy.version) throw new Error('INVALID_STRATEGY');
  const unit = new Money(dataset.instrument.currency === 'KRW' ? '1' : '0.01');
  const tick = new Money(config.priceTick);
  const initial = new Money(config.initialCash);
  if (!initial.mod(unit).isZero() || tick.lt(unit) || !tick.mod(unit).isZero())
    throw new Error('INVALID_BACKTEST_CONFIG');
  const candles = dataset.candles.map((candle) =>
    Object.freeze({ ...candle, instrument: Object.freeze({ ...candle.instrument }) }),
  );
  if (
    candles.some((candle) =>
      [candle.open, candle.high, candle.low, candle.close].some((price) => new Money(price).lte(0)),
    )
  )
    throw new Error('INVALID_BACKTEST_PRICE');
  const days = new Map(dataset.calendars.map((entry) => [entry.day.tradingDate, entry.day]));
  const assessments = new Map(dataset.assessments.map((entry) => [Date.parse(entry.timestamp), entry]));
  const events = candles.flatMap((candle, index) => {
    const regular = days.get(candle.tradingDate)?.sessions.find((session) => session.type === 'regular');
    const assessment = assessments.get(Date.parse(candle.timestamp));
    if (!regular || !assessment?.usableAt) throw new Error('INVALID_BACKTEST_DATASET');
    const sessions = days.get(candle.tradingDate)!.sessions;
    if (
      candle.interval === '1d' &&
      candle.instrument.market === 'KR' &&
      sessions.some((session) => session.type !== 'regular')
    )
      throw new Error('UNSUPPORTED_KR_DAILY_SESSION');
    const close =
      candle.interval === '1m'
        ? Date.parse(candle.timestamp)
        : Math.max(...sessions.map((session) => Date.parse(session.endsAt)));
    const open = candle.interval === '1m' ? close - 60_000 : Date.parse(regular.startsAt);
    return [
      { at: open, kind: 'open' as const, index },
      { at: close, kind: 'close' as const, index },
      { at: Date.parse(assessment.usableAt), kind: 'signal' as const, index },
    ];
  });
  const priority = { close: 0, signal: 1, open: 2 };
  events.sort(
    (left, right) => left.at - right.at || priority[left.kind] - priority[right.kind] || left.index - right.index,
  );
  const signals: BacktestSignal[] = [];
  const fills: BacktestFill[] = [];
  const trades: ClosedTrade[] = [];
  const equity: EquityPoint[] = [];
  let cash = initial;
  let quantity = new Money(0);
  let entryCost = new Money(0);
  let entryFill = -1;
  let realized = new Money(0);
  let fees = new Money(0);
  let taxes = new Money(0);
  let peak = initial;
  let drawdown = new Money(0);
  let pending: { signalIndex: number; barIndex: number; at: number; action: 'BUY' | 'SELL' } | null = null;
  const percent = (value: Decimal, denominator: Decimal) => value.div(denominator).mul(100);
  const point = (at: number, kind: EquityPoint['kind'], price: string) => {
    const value = cash.plus(quantity.mul(price));
    peak = Money.max(peak, value);
    drawdown = Money.max(drawdown, percent(peak.minus(value), peak));
    equity.push({
      timestamp: new Date(at).toISOString(),
      kind,
      equity: value.toFixed(),
      cash: cash.toFixed(),
      quantity: quantity.toFixed(),
      cumulativeReturnPct: percent(value.minus(initial), initial).toFixed(10),
    });
  };
  const charge = (notional: Decimal, bps: string) => notional.mul(bps).div(10_000).div(unit).ceil().mul(unit);
  for (const event of events) {
    const candle = candles[event.index]!;
    if (event.kind === 'signal') {
      const result = strategySignalSchema.safeParse(
        input.strategy.evaluate(
          {
            instrument: candle.instrument,
            evaluatedAt: new Date(event.at).toISOString(),
            closedCandles: Object.freeze(candles.slice(0, event.index + 1)),
            ownedQuantity: quantity.toFixed(),
          },
          parameters,
        ),
      );
      if (!result.success) throw new Error('INVALID_STRATEGY_SIGNAL');
      const signal: BacktestSignal = {
        ...result.data,
        barTimestamp: candle.timestamp,
        evaluatedAt: new Date(event.at).toISOString(),
        status: 'HOLD',
      };
      signals.push(signal);
      if (signal.action === 'HOLD') continue;
      if (pending && pending.action !== signal.action) {
        signals[pending.signalIndex]!.status = 'SUPERSEDED';
        pending = null;
      }
      if (pending) {
        signal.status = 'PENDING_EXISTS';
        continue;
      }
      if (signal.action === 'BUY' && !quantity.isZero()) {
        signal.status = 'ALREADY_LONG';
        continue;
      }
      if (signal.action === 'SELL' && quantity.isZero()) {
        signal.status = 'NO_POSITION';
        continue;
      }
      signal.status = 'PENDING';
      pending = { signalIndex: signals.length - 1, barIndex: event.index, at: event.at, action: signal.action };
    } else if (event.kind === 'open') {
      if (equity.length === 0) point(event.at, 'initial', candle.open);
      if (pending && event.index > pending.barIndex && event.at >= pending.at) {
        const order = pending;
        pending = null;
        const buying = order.action === 'BUY';
        const rawPrice = new Money(candle.open).mul(
          new Money(1).plus(new Money(config.slippageBps).div(10_000).mul(buying ? 1 : -1)),
        );
        const steps = rawPrice.div(tick);
        const price = (buying ? steps.ceil() : steps.floor()).mul(tick);
        const size = buying ? new Money(config.quantity) : quantity;
        const notional = price.mul(size);
        const fee = charge(notional, buying ? config.buyFeeBps : config.sellFeeBps);
        const tax = buying ? new Money(0) : charge(notional, config.sellTaxBps);
        if (price.lte(0)) signals[order.signalIndex]!.status = 'INVALID_PRICE';
        else if (buying ? cash.lt(notional.plus(fee)) : cash.plus(notional).lt(fee.plus(tax)))
          signals[order.signalIndex]!.status = 'INSUFFICIENT_CASH';
        else {
          cash = buying ? cash.minus(notional).minus(fee) : cash.plus(notional).minus(fee).minus(tax);
          if (buying) {
            quantity = size;
            entryCost = notional.plus(fee);
            entryFill = fills.length;
          } else {
            const pnl = notional.minus(fee).minus(tax).minus(entryCost);
            realized = realized.plus(pnl);
            trades.push({ entryFill, exitFill: fills.length, netPnl: pnl.toFixed() });
            quantity = new Money(0);
            entryCost = new Money(0);
          }
          fees = fees.plus(fee);
          taxes = taxes.plus(tax);
          fills.push({
            signalIndex: order.signalIndex,
            action: order.action,
            timestamp: new Date(event.at).toISOString(),
            barTimestamp: candle.timestamp,
            referencePrice: candle.open,
            price: price.toFixed(),
            quantity: size.toFixed(),
            notional: notional.toFixed(),
            fee: fee.toFixed(),
            tax: tax.toFixed(),
            cashAfter: cash.toFixed(),
          });
          signals[order.signalIndex]!.status = 'FILLED';
        }
      }
      point(event.at, 'open', candle.open);
    } else point(event.at, 'close', candle.close);
  }
  if (pending) signals[pending.signalIndex]!.status = 'UNFILLED_END';
  const ending = new Money(equity.at(-1)!.equity);
  const unrealized = quantity.mul(candles.at(-1)!.close).minus(entryCost);
  return {
    formatVersion: 'backtest-report-v1',
    engineVersion: '1.0.0',
    mode: 'paper',
    executionEnabled: false,
    model: 'next-eligible-open-v1',
    strategy: { id: input.strategy.id, version: input.strategy.version, parameters },
    config,
    currency: dataset.instrument.currency,
    datasetRequest: dataset.request,
    pointInTime: false,
    warnings: [
      ...dataset.warnings,
      'SYNTHETIC_FULL_FILLS_NO_LIQUIDITY_MODEL',
      'FIXED_TICK_AND_COST_ASSUMPTIONS',
      'NO_DIVIDEND_FX_OR_CORPORATE_ACTION_CASHFLOWS',
      'SAMPLED_DRAWDOWN_NOT_INTRABAR',
      'NO_FORCED_LIQUIDATION',
    ],
    signals,
    fills,
    trades,
    equity,
    metrics: {
      initialCash: initial.toFixed(),
      endingCash: cash.toFixed(),
      endingQuantity: quantity.toFixed(),
      endingEquity: ending.toFixed(),
      netPnl: ending.minus(initial).toFixed(),
      realizedPnl: realized.toFixed(),
      unrealizedPnl: unrealized.toFixed(),
      cumulativeReturnPct: percent(ending.minus(initial), initial).toFixed(10),
      maxDrawdownPct: drawdown.toFixed(10),
      winRatePct: trades.length
        ? new Money(trades.filter((trade) => new Money(trade.netPnl).gt(0)).length)
            .div(trades.length)
            .mul(100)
            .toFixed(10)
        : null,
      tradeCount: trades.length,
      fillCount: fills.length,
      totalFees: fees.toFixed(),
      totalTax: taxes.toFixed(),
    },
  };
}
