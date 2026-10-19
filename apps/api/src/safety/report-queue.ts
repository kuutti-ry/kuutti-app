import type { Queryable } from "@kuutti/db";
import type {
  ReportListItem,
  ReportOutcome,
  ReportQueueQuery,
  ReportSource,
  SanctionReason,
} from "@kuutti/schema";

// The panel's report queue (#311, TD-5): the reports, both people by account
// id, and how each has figured in reports before. A member of staff who is a
// party to a report, by any account of their identity, past or present, is
// not shown it, nor does it count in a figure they read (ADR-030 §6, Open
// 17): a moderator never learns who reported them. Nothing here reads the
// reporter's note or the conversation's copy; opening a report is #312's,
// with its audit row.

/** The reading member of staff's accounts, the CTE every statement here starts with; `$1` is their identity. */
const MINE = "WITH mine AS (SELECT id FROM account WHERE identity_id = $1)";

/** A report row `r` the reader is no party to. */
const visible = (r: string) =>
  `${r}.reporter_account_id NOT IN (SELECT id FROM mine)
   AND ${r}.reported_account_id NOT IN (SELECT id FROM mine)`;

// shortcut: every report about one person waiting together, however far
// apart they were filed, until #105's rule names its window; and the closed
// filter shows the newest page only, until the record outgrows one and needs
// a keyset cursor like the audit log's (#309).
const ORDER: Record<ReportQueueQuery["state"], string> = {
  // The group whose oldest waited longest first, its reports oldest first.
  open: `min(r.created_at) OVER (PARTITION BY r.reported_account_id),
         r.reported_account_id, r.created_at, r.id`,
  closed: "r.decided_at DESC, r.id DESC",
};

type Row = {
  id: string;
  reason: SanctionReason;
  source: ReportSource;
  created_at: Date;
  outcome: ReportOutcome | null;
  decided_at: Date | null;
  reporter_account_id: string;
  reported_account_id: string;
  filed: number;
  upheld: number;
  received: number;
  sanctions: number;
};

/** A page of reports in one state, as the reader may see them, and how many there are in all. */
export async function listReports(
  db: Queryable,
  staffIdentityId: string,
  { state, limit }: ReportQueueQuery,
): Promise<{ items: ReportListItem[]; total: number }> {
  const open = state === "open";
  const { rows } = await db.query<Row>(
    `${MINE}
     SELECT r.id, r.reason, r.source, r.created_at, r.outcome, r.decided_at,
            r.reporter_account_id, r.reported_account_id,
            (SELECT count(*)::int FROM report f
              WHERE f.reporter_account_id = r.reporter_account_id AND ${visible("f")}) AS filed,
            (SELECT count(*)::int FROM report f
              WHERE f.reporter_account_id = r.reporter_account_id AND f.outcome = 'acted'
                AND ${visible("f")}) AS upheld,
            (SELECT count(*)::int FROM report g
              WHERE g.reported_account_id = r.reported_account_id AND ${visible("g")}) AS received,
            (SELECT count(*)::int FROM sanction s
              WHERE s.account_id = r.reported_account_id) AS sanctions
       FROM report r
      WHERE (r.decided_at IS NULL) = $2 AND ${visible("r")}
      ORDER BY ${ORDER[state]}
      LIMIT $3`,
    [staffIdentityId, open, limit],
  );
  const total = await db.query<{ n: number }>(
    `${MINE} SELECT count(*)::int AS n FROM report r
      WHERE (r.decided_at IS NULL) = $2 AND ${visible("r")}`,
    [staffIdentityId, open],
  );
  return {
    items: rows.map((row) => ({
      id: row.id,
      reason: row.reason,
      source: row.source,
      createdAt: row.created_at.toISOString(),
      outcome: row.outcome,
      decidedAt: row.decided_at?.toISOString() ?? null,
      reporter: { accountId: row.reporter_account_id, filed: row.filed, upheld: row.upheld },
      reported: {
        accountId: row.reported_account_id,
        received: row.received,
        sanctions: row.sanctions,
      },
    })),
    total: total.rows[0]?.n ?? 0,
  };
}

/** What waits in the reports for the front page (#303), as the reader may see it. */
export async function reportSummary(
  db: Queryable,
  staffIdentityId: string,
): Promise<{ waiting: number; oldestSince: Date | null }> {
  const { rows } = await db.query<{ n: number; oldest: Date | null }>(
    `${MINE} SELECT count(*)::int AS n, min(r.created_at) AS oldest FROM report r
      WHERE r.decided_at IS NULL AND ${visible("r")}`,
    [staffIdentityId],
  );
  return { waiting: rows[0]?.n ?? 0, oldestSince: rows[0]?.oldest ?? null };
}
