import type { currencySchema, decimalSchema } from './primitives.js';
export { currencySchema, decimalSchema, instantSchema } from './primitives.js';
export { orderObservationSchema, observedOrderStateSchema } from './order-observation.js';
export type { OrderObservation } from './order-observation.js';
export {
  paperValidationStatusSchema,
  paperValidationRunSchema,
  paperValidationCheckNames,
} from './paper-validation-status.js';
export type { PaperValidationStatus, PaperValidationRun } from './paper-validation-status.js';
import { z } from 'zod';
export { executionRulesSchema } from './execution-rules.js';
export type { ExecutionRules } from './execution-rules.js';
export {
  paperReviewSnapshotSchema,
  paperReviewCheckpointSchema,
  paperReviewReportSchema,
  paperReviewArtifactSchema,
} from './paper-review.js';
export type { PaperReviewSnapshot, PaperReviewCheckpoint, PaperReviewReport } from './paper-review.js';
export { paperPreparationDashboardSchema } from './paper-preparation.js';
export type { PaperPreparationDashboard } from './paper-preparation.js';
export { workerRuntimeSchema, workerStatusSchema } from './worker-status.js';
export type { WorkerRuntime, WorkerStatus } from './worker-status.js';
export {
  paperDiagnosticCodeSchema,
  paperDiagnosticReportSchema,
  paperDiagnosticBatchSchema,
  paperDiagnosticsSchema,
} from './paper-diagnostics.js';
export type { PaperDiagnosticReport, PaperDiagnostics } from './paper-diagnostics.js';
export { observationJobSchema, observationJobsSchema } from './observation-jobs.js';
export type { ObservationJobs } from './observation-jobs.js';
export { paperEquityPointSchema, paperEquityHistorySchema } from './paper-equity.js';
export type { PaperEquityPoint, PaperEquityHistory } from './paper-equity.js';
export {
  paperStrategyHistoryQuerySchema,
  paperStrategyHistoryEntrySchema,
  paperStrategyHistorySchema,
} from './paper-strategy-history.js';
export type { PaperStrategyHistory } from './paper-strategy-history.js';
export {
  watchlistInstrumentSchema,
  watchlistInstrumentsSchema,
  watchlistStateSchema,
  watchlistUpdateSchema,
} from './watchlist.js';
export type { WatchlistState } from './watchlist.js';
export {
  observationErrorSchema,
  observationRecordSchema,
  observationSummarySchema,
  observationManifestSchema,
  observationArtifactSchema,
  observationFailureSchema,
  observationListItemSchema,
  observationReportSchema,
  observationMonitoringSchema,
  observationListSchema,
} from './observation.js';
export type { ObservationRecord, ObservationReport, ObservationList } from './observation.js';
export { paperDataSourceSchema, paperExecutionSourceSchema } from './paper-source.js';
export type { PaperDataSource } from './paper-source.js';
export { ownerLoginSchema, ownerSessionSchema } from './owner.js';
export type { OwnerSession } from './owner.js';
export {
  paperStrategyDefinitionSchema,
  paperStrategyViewSchema,
  paperStrategyUpdateSchema,
  paperStrategyAcknowledgementSchema,
  strategyRevisionSchema,
} from './paper-strategy.js';
export type { PaperStrategyDefinition } from './paper-strategy.js';
export {
  paperDashboardSnapshotSchema,
  paperDashboardStateSchema,
  paperStopAcknowledgementSchema,
  paperReasonSchema,
  paperEventKindSchema,
} from './paper-dashboard.js';
export type { PaperDashboardSnapshot, PaperDashboardState } from './paper-dashboard.js';

export {
  dashboardSnapshotSchema,
  dashboardStateSchema,
  dashboardErrorSchema,
  dashboardWorkerMessageSchema,
} from './dashboard.js';
export type { DashboardSnapshot, DashboardState, DashboardErrorCode } from './dashboard.js';
export { dataBlockerSchema, marketDataQualitySchema } from './market-data.js';
export type { DataBlocker, MarketDataQuality } from './market-data.js';
export {
  movingAverageConfigSchema,
  strategySignalSchema,
  backtestConfigSchema,
  movingAverageBacktestConfigSchema,
} from './backtest.js';
export type { MovingAverageConfig, BacktestConfig } from './backtest.js';
export {
  paperSignalSchema,
  paperLedgerStateSchema,
  paperEvidenceSchema,
  paperRecordedOrderSchema,
  paperIntentStateSchema,
  paperFillRequestSchema,
  paperObservationSchema,
} from './paper-ledger.js';
export type { PaperSignal, PaperLedgerState, PaperEvidence, PaperIntentState } from './paper-ledger.js';
export {
  paperRiskLimitsSchema,
  paperControlSchema,
  paperOrderCandidateSchema,
  paperRiskSnapshotSchema,
  paperRiskInputSchema,
  riskBlockerSchema,
} from './risk.js';
export type {
  PaperRiskLimits,
  PaperControl,
  PaperOrderCandidate,
  PaperRiskSnapshot,
  PaperRiskInput,
  RiskBlocker,
} from './risk.js';
export {
  reportHashSchema,
  backtestArtifactSchema,
  backtestSummarySchema,
  backtestListSchema,
} from './backtest-reports.js';
export type { BacktestArtifact, BacktestSummary, BacktestList } from './backtest-reports.js';
export {
  historicalCandleSchema,
  historicalRequestSchema,
  historicalObservationSchema,
  historicalCalendarSchema,
  historicalDatasetSchema,
} from './historical.js';
export type {
  HistoricalRequest,
  HistoricalObservation,
  HistoricalCalendarObservation,
  HistoricalDataset,
} from './historical.js';

export const marketSchema = z.enum(['KR', 'US']);
export const paperModeSchema = z.literal('paper').default('paper');

export type Market = z.infer<typeof marketSchema>;
export type Currency = z.infer<typeof currencySchema>;
export type DecimalString = z.infer<typeof decimalSchema>;

export interface InstrumentId {
  readonly market: Market;
  readonly symbol: string;
}

export interface Money {
  readonly amount: DecimalString;
  readonly currency: Currency;
}

export interface MarketSession {
  readonly type: 'day' | 'pre' | 'regular' | 'after';
  readonly startsAt: string;
  readonly endsAt: string;
}

export interface MarketDay {
  readonly market: Market;
  readonly tradingDate: string;
  readonly sessions: readonly MarketSession[];
  readonly sessionsKnown: boolean;
}

export interface MarketCalendar {
  readonly today: MarketDay;
  readonly previousBusinessDay: MarketDay;
  readonly nextBusinessDay: MarketDay;
}

export interface Candle {
  readonly instrument: InstrumentId;
  readonly interval: '1m' | '1d';
  readonly timestamp: string;
  readonly tradingDate: string;
  readonly open: DecimalString;
  readonly high: DecimalString;
  readonly low: DecimalString;
  readonly close: DecimalString;
  readonly volume: DecimalString;
  readonly currency: Currency;
  readonly adjusted: boolean;
  readonly source: string;
  readonly isClosed: boolean;
}

export const processHealthSchema = z.object({
  status: z.literal('ok'),
  service: z.literal('api'),
  mode: z.literal('paper'),
  executionEnabled: z.literal(false),
  scope: z.literal('process-only'),
});

export type ProcessHealth = z.infer<typeof processHealthSchema>;

export { paperRunDiagnosticsArtifactSchema, paperRunDiagnosticsSummarySchema } from './paper-run-diagnostics.js';
export type { PaperRunDiagnosticsArtifact, PaperRunDiagnosticsSummary } from './paper-run-diagnostics.js';

export {
  tokenLifecycleTriggerSchema,
  tokenLifecycleEventSchema,
  tokenLifecycleSnapshotSchema,
  observationTokenLifecycleSchema,
} from './token-lifecycle.js';
export type { TokenLifecycleTrigger, TokenLifecycleEvent, TokenLifecycleSnapshot } from './token-lifecycle.js';

export { paperValidationFailureCodeSchema } from './paper-validation-status.js';

export { backtestCostPairSchema } from './backtest-cost-pair.js';
export type { BacktestCostPair } from './backtest-cost-pair.js';

export { channelBreakoutConfigSchema, meanReversionConfigSchema } from './research-strategies.js';
export type { ChannelBreakoutConfig, MeanReversionConfig } from './research-strategies.js';

export { createBacktestReportSchema } from './backtest-reports.js';

export {
  capitalExposureSchema,
  researchStrategyDefinitionSchema,
  strategyResearchSnapshotSchema,
  strategyResearchSummarySchema,
  strategyResearchListSchema,
} from './strategy-research.js';
export type {
  CapitalExposure,
  StrategyResearchSnapshot,
  StrategyResearchSummary,
  StrategyResearchList,
} from './strategy-research.js';

export { buyAndHoldConfigSchema } from './benchmark-strategy.js';
export type { BuyAndHoldConfig } from './benchmark-strategy.js';

export { orderReconciliationReportSchema } from './order-reconciliation-report.js';
export type { OrderReconciliationReport } from './order-reconciliation-report.js';

export { syntheticOrderBindingInputSchema, syntheticOrderBindingReviewSchema } from './synthetic-order-binding.js';
export type { SyntheticOrderBindingInput, SyntheticOrderBindingReview } from './synthetic-order-binding.js';
