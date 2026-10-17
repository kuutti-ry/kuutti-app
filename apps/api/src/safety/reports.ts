import { type Queryable, transaction } from "@kuutti/db";
import type { ReportOutcome, SanctionReason } from "@kuutti/schema";
import { wasShown } from "../media/index.ts";
import { blockStandsBetween, insertBlock } from "./blocks.ts";

/**
 * Reports (#84, ADR-030, features/safety/reports.feature): a person tells the
 * moderators about somebody whose card they were shown, with a reason of
 * #106's list and, if they like, a few lines; the report blocks both ways in
 * the same transaction. The reported person learns nothing. The note reaches
 * no log line, error detail or research event (rule 5). At most
 * matching_config reports_per_day per account and Finnish day, counted under
 * an advisory lock per account (the feedback's lock); one open report per
 * pair. Both are asked before the card is, so neither answer tells whether
 * the other person, or their photos, are still there. The moderators read and
 * decide them in the panel (#311, #312). Kept twelve months from filing,
 * whoever of the two is erased meanwhile; the night prunes the rest.
 */

export const REPORTS_PER_DAY_KEY = "reports_per_day";

/** Twelve months (TD-7's report snapshots, rules/db.md); the nightly prune keeps it. */
export const REPORT_RETENTION_DAYS = 365;

/** A day here is 24 hours, in SQL as in JS, as for the photo check's notes. */
const DAY_MS = 86_400_000;

export type NewReport = {
  reporterAccountId: string;
  reportedAccountId: string;
  reason: SanctionReason;
  note: string | null;
  at: Date;
  /** Start of the cap's day; rows from before it do not count. */
  since: Date;
  limit: number;
};

export type ReportRecord =
  /** Filed, and the block with it. */
  | { outcome: "filed" }
  /** One is open for the pair already: nothing written, nothing counted. */
  | { outcome: "open" }
  /** Over the day's cap: nothing written, the block neither. */
  | { outcome: "over_budget"; used: number }
  /** Never shown, oneself, nobody, a later account of somebody blocked, or the caller erased: nothing written. */
  | { outcome: "not_found" };

/**
 * The report and its block in one transaction. The reporter's row is held
 * (`FOR SHARE`, as every writer takes it) so an erasure either finishes first
 * and nothing is written, or waits until both rows are; every report of the
 * reporter's is written under their advisory lock, so two at once cannot both
 * pass the day's count. An open report and the cap answer before the proof of
 * contact (ADR-030 §6): the same answer whoever is named. The proof is a
 * block that stands between the two, set while both accounts existed, or a
 * card shown: so a blocked person can report the one who blocked them, and a
 * report decided and asked again is filed again, whether or not the other is
 * still there.
 */
export async function recordReport(db: Queryable, input: NewReport): Promise<ReportRecord> {
  return transaction(db, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `report:${input.reporterAccountId}`,
    ]);
    const live = await tx.query(
      "SELECT 1 FROM account WHERE id = $1 AND state <> 'deleted' FOR SHARE",
      [input.reporterAccountId],
    );
    if (live.rows.length === 0) return { outcome: "not_found" };
    const { rows } = await tx.query<{ open: boolean; used: number }>(
      `SELECT EXISTS (SELECT 1 FROM report WHERE reporter_account_id = $1
                        AND reported_account_id = $2 AND decided_at IS NULL) AS open,
              (SELECT count(*)::int FROM report
               WHERE reporter_account_id = $1 AND created_at >= $3) AS used`,
      [input.reporterAccountId, input.reportedAccountId, input.since],
    );
    const row = rows[0];
    if (!row) throw new Error("report count returned no row");
    if (row.open) return { outcome: "open" };
    if (row.used >= input.limit) return { outcome: "over_budget", used: row.used };
    // Proof of contact: a block that stands between the two (a report blocks
    // too, so a report decided and asked again finds one), else a card shown.
    const proven =
      (await blockStandsBetween(tx, {
        callerAccountId: input.reporterAccountId,
        otherAccountId: input.reportedAccountId,
      })) ||
      (await wasShown(tx, {
        viewerAccountId: input.reporterAccountId,
        subjectAccountId: input.reportedAccountId,
      }));
    if (!proven) return { outcome: "not_found" };
    await tx.query(
      `INSERT INTO report (reporter_account_id, reported_account_id, source, reason, note, created_at)
       VALUES ($1, $2, 'card', $3::sanction_reason, $4, $5)`,
      [input.reporterAccountId, input.reportedAccountId, input.reason, input.note, input.at],
    );
    // The reporter's row is held above, so the block finds them live.
    await insertBlock(tx, {
      blockerAccountId: input.reporterAccountId,
      blockedAccountId: input.reportedAccountId,
      at: input.at,
    });
    return { outcome: "filed" };
  });
}

export type FiledReport = {
  at: Date;
  reason: SanctionReason;
  note: string | null;
  outcome: ReportOutcome | null;
  decidedAt: Date | null;
};

/**
 * The reports the person filed, for their export (ADR-030 §8), newest first:
 * when, why, their own words and what came of it, never whom. From this
 * account or an earlier one of the same identity, the blocks' scope: both
 * are kept through an erasure, so both are the person's to read after
 * coming back. A report about the person is not theirs to read here
 * (ADR-024 §8's reasoning, GDPR Art. 15(4)). Scoped by the caller's account
 * (rule 6).
 */
export async function listReportsOfAccount(
  db: Queryable,
  accountId: string,
  limit: number,
): Promise<FiledReport[]> {
  const { rows } = await db.query<{
    created_at: Date;
    reason: SanctionReason;
    note: string | null;
    outcome: ReportOutcome | null;
    decided_at: Date | null;
  }>(
    `SELECT r.created_at, r.reason, r.note, r.outcome, r.decided_at FROM report r
     JOIN account filer ON filer.id = r.reporter_account_id
     JOIN account me ON me.identity_id = filer.identity_id
     WHERE me.id = $1
     ORDER BY r.created_at DESC, r.id DESC LIMIT $2`,
    [accountId, limit],
  );
  return rows.map((row) => ({
    at: row.created_at,
    reason: row.reason,
    note: row.note,
    outcome: row.outcome,
    decidedAt: row.decided_at,
  }));
}

/** The nightly prune: a report filed more than twelve months ago goes, open or decided; its block stays. */
export async function pruneReports(db: Queryable, now: Date): Promise<number> {
  const result = await db.query("DELETE FROM report WHERE created_at < $1", [
    new Date(now.getTime() - REPORT_RETENTION_DAYS * DAY_MS),
  ]);
  return result.rowCount ?? 0;
}
