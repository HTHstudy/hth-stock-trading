import { Decimal } from 'decimal.js';
import { strategyResearchSnapshotSchema } from '@hth/contracts';

const Money = Decimal.clone({ precision: 1000 });

// Server-only arithmetic validation of stored summaries. No source files, strategy, or I/O.
export function parseStrategyResearchSnapshot(input: unknown) {
  const snapshot = strategyResearchSnapshotSchema.parse(input);
  const rows = new Map(snapshot.rows.map((row) => [row.reportHash, row]));
  for (const row of snapshot.rows) {
    if (row.comparisonStatus !== 'compared') continue;
    const baseline = rows.get(row.benchmarkReportHash!);
    if (
      !baseline ||
      row.netPnlDifference === null ||
      !new Money(row.metrics.netPnl).minus(baseline.metrics.netPnl).eq(row.netPnlDifference)
    )
      throw new Error('INVALID_RESEARCH_ARITHMETIC');
  }
  return snapshot;
}
