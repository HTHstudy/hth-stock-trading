import { asc, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { paperReviewSnapshotSchema } from '@hth/contracts';
import type * as schema from './schema.js';
import { paperEvents } from './schema.js';
import { contentHash } from './content-hash.js';

// Share ordering, microsecond timestamps and public event mapping with locked ledger guards.
export async function readPaperReviewEvents(db: Pick<NodePgDatabase<typeof schema>, 'select'>, accountId: string) {
  const rows = await db
    .select({
      id: paperEvents.id,
      kind: paperEvents.kind,
      createdAt: sql<string>`to_char(${paperEvents.createdAt} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    })
    .from(paperEvents)
    .where(eq(paperEvents.accountId, accountId))
    .orderBy(asc(paperEvents.createdAt), asc(paperEvents.id))
    .limit(5001);
  if (rows.length > 5000) throw new Error('PAPER_REVIEW_LIMIT_EXCEEDED');
  const eventKind = paperReviewSnapshotSchema.shape.events.element.shape.kind;
  return rows.map((row) => ({
    key: contentHash(row.id),
    kind: eventKind.safeParse(row.kind).success ? row.kind : 'OTHER',
    createdAt: row.createdAt,
  }));
}
