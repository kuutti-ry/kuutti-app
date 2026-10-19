import type { Queryable } from "@kuutti/db";
import type {
  ReportActable,
  ReportCopyLine,
  ReportDecision,
  ReportDecisionRequest,
  ReportDetail,
  ReportListItem,
  ReportMessageSide,
  ReportOutcome,
  ReportQueueQuery,
  ReportSource,
  SanctionKind,
  SanctionReason,
} from "@kuutti/schema";
import { AppError } from "../lib/errors.ts";
import { recordAudit } from "./audit.ts";

// The panel's report queue (#311, TD-5) and one report opened and decided
// (#312): the reports, both people by account id, and how each has figured in
// reports before. A member of staff who is a party to a report, by any
// account of their identity, past or present, is not shown it, cannot open or
// decide it, and it counts in no figure they read (ADR-030 §6, Open 17): a
// moderator never learns who reported them, and every statement here holds
// that in its own WHERE. The reporter's note and the conversation's frozen
// copy are read only when a report is opened, after its audit row (the
// route's), and their words go nowhere but the answer (rule 5).

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

/** The queue's item: the row and both people's figures, each counting only reports the reader may see. */
const ITEM = `r.id, r.reason, r.source, r.created_at, r.outcome, r.decided_at,
  r.reporter_account_id, r.reported_account_id,
  (SELECT count(*)::int FROM report f
    WHERE f.reporter_account_id = r.reporter_account_id AND ${visible("f")}) AS filed,
  (SELECT count(*)::int FROM report f
    WHERE f.reporter_account_id = r.reporter_account_id AND f.outcome = 'acted'
      AND ${visible("f")}) AS upheld,
  (SELECT count(*)::int FROM report g
    WHERE g.reported_account_id = r.reported_account_id AND ${visible("g")}) AS received,
  (SELECT count(*)::int FROM sanction s
    WHERE s.account_id = r.reported_account_id) AS sanctions`;

type ItemRow = {
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

const itemOf = (row: ItemRow): ReportListItem => ({
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
});

/** A page of reports in one state, as the reader may see them, and how many there are in all. */
export async function listReports(
  db: Queryable,
  staffIdentityId: string,
  { state, limit }: ReportQueueQuery,
): Promise<{ items: ReportListItem[]; total: number }> {
  const open = state === "open";
  const { rows } = await db.query<ItemRow>(
    `${MINE} SELECT ${ITEM} FROM report r
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
  return { items: rows.map(itemOf), total: total.rows[0]?.n ?? 0 };
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

/**
 * A sanction `s` that may close report `r` as acted on (#312): on the
 * reported account, or a ban of its identity set through any of its accounts
 * (the set the person's page lists), applied by a person at or after the
 * filing. Lifted or reviewed ones answer too, and one sanction may close
 * several reports; what no person applied (#105's rules) does not.
 */
const NAMEABLE = `s.created_by IS NOT NULL AND s.created_at >= r.created_at
  AND (s.account_id = r.reported_account_id
       OR (s.kind = 'ban' AND s.identity_id =
           (SELECT a.identity_id FROM account a WHERE a.id = r.reported_account_id)))`;

/** Where a report the reader may open was made, before anything of it is read; null for an unknown id or a party. */
export async function findReportSource(
  db: Queryable,
  staffIdentityId: string,
  id: string,
): Promise<ReportSource | null> {
  const { rows } = await db.query<{ source: ReportSource }>(
    `${MINE} SELECT r.source FROM report r WHERE r.id = $2 AND ${visible("r")}`,
    [staffIdentityId, id],
  );
  return rows[0]?.source ?? null;
}

type CopyRow = {
  seq: number;
  side: ReportMessageSide;
  kind: ReportCopyLine["kind"];
  body: string | null;
  photo: boolean;
  created_at: Date;
};

type ActableRow = {
  id: string;
  kind: SanctionKind;
  reason: SanctionReason;
  created_at: Date;
  lifted_at: Date | null;
};

/**
 * One report as a moderator opens it, after the route has written the look's
 * audit row in the same transaction: the queue's item, the note, the
 * decision, the frozen copy for a conversation's report, and the sanctions
 * that may close it while it waits. Null for an unknown id or a party.
 */
export async function openReport(
  db: Queryable,
  staffIdentityId: string,
  id: string,
): Promise<ReportDetail | null> {
  const { rows } = await db.query<
    ItemRow & { note: string | null; decided_by: string | null; sanction_id: string | null }
  >(
    `${MINE} SELECT ${ITEM}, r.note, r.decided_by, r.sanction_id
       FROM report r WHERE r.id = $2 AND ${visible("r")}`,
    [staffIdentityId, id],
  );
  const row = rows[0];
  if (!row) return null;
  // shortcut: the copy is answered whole, as the export answers a
  // conversation; one of some thousands of lines makes a heavy answer and
  // page, and paging by seq would lift it.
  const copy =
    row.source === "conversation"
      ? (
          await db.query<CopyRow>(
            `${MINE} SELECT rm.seq, rm.side, rm.kind, rm.body, rm.photo_id IS NOT NULL AS photo,
                    rm.created_at
               FROM report r JOIN report_message rm ON rm.report_id = r.id
              WHERE r.id = $2 AND ${visible("r")}
              ORDER BY rm.seq`,
            [staffIdentityId, id],
          )
        ).rows.map(
          (line): ReportCopyLine => ({
            seq: line.seq,
            side: line.side,
            kind: line.kind,
            body: line.body,
            photo: line.photo,
            createdAt: line.created_at.toISOString(),
          }),
        )
      : null;
  const actable = await db.query<ActableRow>(
    `${MINE} SELECT s.id, s.kind, s.reason, s.created_at, s.lifted_at
       FROM report r JOIN sanction s ON ${NAMEABLE}
      WHERE r.id = $2 AND r.decided_at IS NULL AND ${visible("r")}
      ORDER BY s.created_at DESC, s.id DESC
      LIMIT 100`,
    [staffIdentityId, id],
  );
  return {
    ...itemOf(row),
    note: row.note,
    decidedBy: row.decided_by,
    sanctionId: row.sanction_id,
    copy,
    actable: actable.rows.map(
      (s): ReportActable => ({
        id: s.id,
        kind: s.kind,
        reason: s.reason,
        createdAt: s.created_at.toISOString(),
        liftedAt: s.lifted_at?.toISOString() ?? null,
      }),
    ),
  };
}

/** The photo a report's copy holds at `seq`, its id and stored key; null for an unknown report, a party, a text line or a photo removed before the filing. */
export async function copyPhotoOf(
  db: Queryable,
  staffIdentityId: string,
  id: string,
  seq: number,
): Promise<{ photoId: string; key: string } | null> {
  const { rows } = await db.query<{ id: string; key: string }>(
    `${MINE} SELECT p.id, p.key FROM report r
       JOIN report_message rm ON rm.report_id = r.id AND rm.seq = $3
       JOIN photo p ON p.id = rm.photo_id
      WHERE r.id = $2 AND ${visible("r")}`,
    [staffIdentityId, id, seq],
  );
  const row = rows[0];
  return row ? { photoId: row.id, key: row.key } : null;
}

const notFound = () => new AppError(404, "not_found", "No such report");
const decided = () => new AppError(409, "report_decided", "The report is decided already");

/**
 * A moderator's decision (#312), inside the caller's transaction: the check,
 * the audit row, and the update keyed on the report still waiting, so of two
 * moderators deciding at once exactly one writes and the other's audit row is
 * rolled back with its refusal. A party is answered as for an unknown report
 * before anything else is asked. Nothing is told to either person (#176).
 */
export async function decideReport(
  tx: Queryable,
  input: { staffIdentityId: string; id: string; decision: ReportDecisionRequest; at: Date },
): Promise<ReportDecision> {
  const { staffIdentityId, id, decision, at } = input;
  const sanctionId = decision.outcome === "acted" ? decision.sanctionId : null;
  const { rows } = await tx.query<{ decided: boolean; fits: boolean }>(
    `${MINE} SELECT r.decided_at IS NOT NULL AS decided,
            ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM sanction s WHERE s.id = $3 AND ${NAMEABLE})) AS fits
       FROM report r WHERE r.id = $2 AND ${visible("r")}`,
    [staffIdentityId, id, sanctionId],
  );
  const check = rows[0];
  if (!check) throw notFound();
  if (check.decided) throw decided();
  if (!check.fits) {
    throw new AppError(409, "sanction_not_for_report", "The sanction does not answer this report");
  }
  await recordAudit(tx, {
    actorIdentityId: staffIdentityId,
    action: "report.decide",
    subjectType: "report",
    subjectId: id,
    detail: { outcome: decision.outcome, sanctionId },
  });
  const updated = await tx.query<{
    outcome: ReportOutcome;
    decided_at: Date;
    sanction_id: string | null;
  }>(
    `${MINE} UPDATE report r
        SET outcome = $3::report_outcome, decided_at = $4, decided_by = $1, sanction_id = $5
      WHERE r.id = $2 AND r.decided_at IS NULL AND ${visible("r")}
      RETURNING r.outcome, r.decided_at, r.sanction_id`,
    [staffIdentityId, id, decision.outcome, at, sanctionId],
  );
  const row = updated.rows[0];
  if (!row) throw decided();
  return {
    id,
    outcome: row.outcome,
    decidedAt: row.decided_at.toISOString(),
    decidedBy: staffIdentityId,
    sanctionId: row.sanction_id,
  };
}
